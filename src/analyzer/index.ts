import * as fs from 'fs';
import * as path from 'path';
import { Node, Project, SourceFile, SyntaxKind } from 'ts-morph';
import { analyzeReactFile } from './react-analyzer';
import { analyzeVueFile } from './vue-analyzer';
import { findMFConfig } from './mf-analyzer';
import { ExportInfo, FileInfo, MFDep, ModuleSkeleton } from './types';

const SUPPORTED_EXT = new Set(['.ts', '.tsx', '.js', '.vue']);
const IGNORED_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', '.git',
  '__tests__', 'test', 'tests', 'coverage',
]);

export async function analyzeModule(
  modulePath: string,
  companyScopes: string[] = [],
  targetFile?: string   // when set, analyse only this single file
): Promise<ModuleSkeleton> {
  const mfConfig = findMFConfig(modulePath);
  const mfRemoteNames = mfConfig?.remoteNames ?? [];

  const allFiles = targetFile ? [targetFile] : collectFiles(modulePath);
  const tsFiles = allFiles.filter((f) => /\.(ts|tsx|js)$/.test(f));
  const vueFiles = allFiles.filter((f) => f.endsWith('.vue'));

  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: true, skipLibCheck: true, noEmit: true },
  });

  const sourceFiles: SourceFile[] = tsFiles
    .map((f) => {
      try {
        return project.addSourceFileAtPath(f);
      } catch {
        return null;
      }
    })
    .filter((sf): sf is SourceFile => sf !== null);

  const fileInfos: FileInfo[] = [];

  for (const sf of sourceFiles) {
    try {
      fileInfos.push(analyzeReactFile(sf, modulePath, mfRemoteNames));
    } catch {
      /* skip unparseable files */
    }
  }

  for (const filePath of vueFiles) {
    try {
      fileInfos.push(analyzeVueFile(filePath, modulePath, mfRemoteNames));
    } catch {
      /* skip unparseable files */
    }
  }

  const { externalDeps, companyDeps } = collectDeps(fileInfos, companyScopes);

  return {
    modulePath,
    files: fileInfos,
    publicExports: targetFile
      ? extractSingleFileExports(targetFile, fileInfos, project)
      : extractPublicExports(modulePath, fileInfos, project),
    externalDeps,
    companyDeps,
    mfDeps: collectMFDeps(fileInfos),
  };
}

function collectFiles(dir: string): string[] {
  const results: string[] = [];

  function walk(current: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (SUPPORTED_EXT.has(path.extname(entry.name))) {
        results.push(fullPath);
      }
    }
  }

  walk(dir);
  return results;
}

function extractSingleFileExports(
  filePath: string,
  files: FileInfo[],
  project: Project
): ExportInfo[] {
  const sf = project.getSourceFile(filePath);
  if (sf) {
    const result: ExportInfo[] = [];
    for (const [name, decls] of sf.getExportedDeclarations()) {
      const declFile = decls[0]?.getSourceFile().getFilePath() ?? filePath;
      result.push({ name, kind: guessExportKind(name, decls[0]), filePath: declFile });
    }
    return result;
  }
  // Fallback: use already-parsed FileInfo
  const fileInfo = files[0];
  if (!fileInfo) return [];
  return fileInfo.exports.map((name) => ({
    name,
    kind: guessExportKind(name),
    filePath,
  }));
}

function extractPublicExports(
  modulePath: string,
  files: FileInfo[],
  project: Project
): ExportInfo[] {
  const indexRelPaths = ['index.ts', 'index.tsx', 'index.js'];
  const indexFile = files.find((f) => indexRelPaths.includes(f.relativePath));
  if (!indexFile) return [];

  const indexAbsPath = path.join(modulePath, indexFile.relativePath);
  const sf = project.getSourceFile(indexAbsPath);

  if (sf) {
    // Use ts-morph to resolve re-exports to their actual declaration file
    const result: ExportInfo[] = [];
    for (const [name, decls] of sf.getExportedDeclarations()) {
      const declFile = decls[0]?.getSourceFile().getFilePath() ?? indexAbsPath;
      result.push({ name, kind: guessExportKind(name, decls[0]), filePath: declFile });
    }
    return result;
  }

  // Fallback: all point to index file
  return indexFile.exports.map((name) => ({
    name,
    kind: guessExportKind(name),
    filePath: indexAbsPath,
  }));
}

function guessExportKind(name: string, decl?: Node): ExportInfo['kind'] {
  if (name === 'default') {
    return guessDefaultExportKind(decl);
  }
  if (/^use[A-Z]/.test(name)) return 'hook';
  if (/(?:Type|Interface|Props|State)$/.test(name)) return 'type';
  if (/^[A-Z]/.test(name)) return 'component';
  if (/^[a-z]/.test(name)) return 'util';
  return 'unknown';
}

function guessDefaultExportKind(decl?: Node): ExportInfo['kind'] {
  if (!decl) return 'component';
  const kind = decl.getKind();
  if (
    kind === SyntaxKind.InterfaceDeclaration ||
    kind === SyntaxKind.TypeAliasDeclaration
  ) return 'type';
  if (kind === SyntaxKind.ClassDeclaration) return 'component';
  if (kind === SyntaxKind.FunctionDeclaration || kind === SyntaxKind.ArrowFunction) {
    const filePath = decl.getSourceFile().getFilePath();
    if (/\.(tsx|vue)$/.test(filePath)) return 'component';
    const name = (decl as { getName?: () => string | undefined }).getName?.() ?? '';
    if (/^use[A-Z]/.test(name)) return 'hook';
    return 'component';
  }
  return 'component';
}

function collectDeps(
  files: FileInfo[],
  companyScopes: string[]
): { externalDeps: string[]; companyDeps: string[] } {
  const npmSet = new Set<string>();
  const companySet = new Set<string>();

  for (const file of files) {
    for (const imp of file.imports) {
      if (imp.kind !== 'thirdParty') continue;
      // Normalize 'react-dom/client' → 'react-dom', '@scope/pkg/sub' → '@scope/pkg'
      const pkg = imp.source.startsWith('@')
        ? imp.source.split('/').slice(0, 2).join('/')
        : imp.source.split('/')[0];

      if (companyScopes.some((s) => pkg.startsWith(s))) {
        companySet.add(pkg);
      } else {
        npmSet.add(pkg);
      }
    }
  }

  return {
    externalDeps: [...npmSet].sort(),
    companyDeps: [...companySet].sort(),
  };
}

function collectMFDeps(files: FileInfo[]): MFDep[] {
  const seen = new Set<string>();
  const deps: MFDep[] = [];

  for (const file of files) {
    for (const imp of file.imports) {
      if (imp.kind === 'mf' && !seen.has(imp.source)) {
        seen.add(imp.source);
        const slash = imp.source.indexOf('/');
        deps.push({
          remote: slash >= 0 ? imp.source.slice(0, slash) : imp.source,
          exposedPath: slash >= 0 ? imp.source.slice(slash) : '/',
        });
      }
    }
  }
  return deps;
}
