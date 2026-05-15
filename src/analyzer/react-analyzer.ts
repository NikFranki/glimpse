import * as path from 'path';
import { SyntaxKind, SourceFile } from 'ts-morph';
import { FileInfo, FileType, ImportRef } from './types';

export function analyzeReactFile(
  sourceFile: SourceFile,
  modulePath: string,
  mfRemoteNames: string[]
): FileInfo {
  const filePath = sourceFile.getFilePath();
  const relativePath = path.relative(modulePath, filePath);
  const ext = path.extname(filePath).slice(1) as FileType;

  const exports: string[] = [];
  for (const [name] of sourceFile.getExportedDeclarations()) {
    exports.push(name);
  }

  const imports: ImportRef[] = sourceFile.getImportDeclarations().map((decl) => {
    const source = decl.getModuleSpecifierValue();
    const names = [...decl.getNamedImports().map((n) => n.getName())];
    const defaultImp = decl.getDefaultImport();
    if (defaultImp) names.push(defaultImp.getText());
    return { source, kind: classifyImport(source, mfRemoteNames), names };
  });

  const propsFields = extractPropsFields(sourceFile);
  const stateVars = extractStateVars(sourceFile);
  const functionNames = extractFunctionNames(sourceFile);
  const jsxElements = ext === 'tsx' ? extractJsxElements(sourceFile) : [];

  return {
    relativePath,
    type: ext,
    exports,
    imports,
    ...(propsFields.length && { propsFields }),
    ...(stateVars.length && { stateVars }),
    ...(functionNames.length && { functionNames }),
    ...(jsxElements.length && { jsxElements }),
  };
}

// ── Props ──────────────────────────────────────────────────────────────────

function extractPropsFields(sf: SourceFile): string[] {
  const fields: string[] = [];

  // interface XxxProps { propA: ...; propB: ... }
  for (const iface of sf.getInterfaces()) {
    if (/Props$/.test(iface.getName() ?? '')) {
      fields.push(...iface.getProperties().map((p) => p.getName()));
    }
  }

  // type XxxProps = { propA: ...; propB: ... }
  for (const ta of sf.getTypeAliases()) {
    if (/Props$/.test(ta.getName())) {
      const tl = ta.getTypeNode()?.asKind(SyntaxKind.TypeLiteral);
      if (tl) {
        for (const m of tl.getMembers()) {
          const ps = m.asKind(SyntaxKind.PropertySignature);
          if (ps) fields.push(ps.getName());
        }
      }
    }
  }

  return fields;
}

// ── State (useState / useReducer / useContext) ─────────────────────────────

function extractStateVars(sf: SourceFile): string[] {
  const vars: string[] = [];

  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression().getText();

    // useState / useReducer → const [value, setter] = useXxx(...)
    if (
      expr === 'useState' || expr.endsWith('.useState') ||
      expr === 'useReducer' || expr.endsWith('.useReducer')
    ) {
      const varDecl = call.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
      if (!varDecl) continue;
      const abp = varDecl.getNameNode().asKind(SyntaxKind.ArrayBindingPattern);
      if (!abp) continue;
      const first = abp.getElements()[0]?.asKind(SyntaxKind.BindingElement);
      const name = first?.getNameNode().getText();
      if (name) vars.push(name);
      continue;
    }

    // useContext → const value = useContext(...) or const { a, b } = useContext(...)
    if (expr === 'useContext' || expr.endsWith('.useContext')) {
      const varDecl = call.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
      if (!varDecl) continue;
      const nameNode = varDecl.getNameNode();

      if (nameNode.getKind() === SyntaxKind.Identifier) {
        // const ctx = useContext(...)
        vars.push(nameNode.getText());
      } else {
        // const { user, theme } = useContext(...)
        const obp = nameNode.asKind(SyntaxKind.ObjectBindingPattern);
        for (const el of obp?.getElements() ?? []) {
          const name = el.asKind(SyntaxKind.BindingElement)?.getNameNode().getText();
          if (name) vars.push(name);
        }
      }
    }
  }

  return vars;
}

// ── Functions / methods ────────────────────────────────────────────────────

function extractFunctionNames(sf: SourceFile): string[] {
  const names = new Set<string>();

  // Regular function declarations starting with lowercase
  for (const fn of sf.getFunctions()) {
    const name = fn.getName();
    if (name && /^[a-z]/.test(name)) names.add(name);
  }

  // Arrow / function expressions in variable declarations
  for (const decl of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const name = decl.getName();
    if (!/^[a-z]/.test(name)) continue;
    const kind = decl.getInitializer()?.getKind();
    if (kind === SyntaxKind.ArrowFunction || kind === SyntaxKind.FunctionExpression) {
      names.add(name);
    }
  }

  return [...names].slice(0, 15);
}

// ── JSX component tags ─────────────────────────────────────────────────────

function extractJsxElements(sf: SourceFile): string[] {
  const elements = new Set<string>();

  for (const el of sf.getDescendantsOfKind(SyntaxKind.JsxOpeningElement)) {
    const name = el.getTagNameNode().getText();
    if (/^[A-Z]/.test(name)) elements.add(name);
  }
  for (const el of sf.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement)) {
    const name = el.getTagNameNode().getText();
    if (/^[A-Z]/.test(name)) elements.add(name);
  }

  return [...elements];
}

// ── Import classification ──────────────────────────────────────────────────

export function classifyImport(
  source: string,
  mfRemoteNames: string[]
): 'local' | 'thirdParty' | 'mf' {
  if (source.startsWith('.')) return 'local';
  // '@/' and '~/' are common webpack/CRA aliases that resolve to src/
  if (source.startsWith('@/') || source.startsWith('~/')) return 'local';
  for (const remote of mfRemoteNames) {
    if (source === remote || source.startsWith(`${remote}/`)) return 'mf';
  }
  return 'thirdParty';
}
