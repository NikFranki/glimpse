import * as fs from 'fs';
import * as path from 'path';
import { Project, SourceFile, SyntaxKind } from 'ts-morph';
import { parseComponent } from 'vue-template-compiler';
import { FileInfo, ImportRef } from './types';
import { classifyImport } from './react-analyzer';

// Shared in-memory project for Vue script blocks — avoids recreating per file
const vueProject = new Project({ useInMemoryFileSystem: true });
const VIRTUAL_FILE = '/vue-script.ts';

export function analyzeVueFile(
  filePath: string,
  modulePath: string,
  mfRemoteNames: string[]
): FileInfo {
  const relativePath = path.relative(modulePath, filePath);
  const source = fs.readFileSync(filePath, 'utf-8');
  const sfc = parseComponent(source);
  const scriptContent = sfc.script?.content ?? '';

  const exports: string[] = [];
  const imports: ImportRef[] = [];
  let propsFields: string[] | undefined;
  let stateVars: string[] | undefined;
  let functionNames: string[] | undefined;

  if (scriptContent.trim()) {
    let sf = vueProject.getSourceFile(VIRTUAL_FILE);
    if (sf) {
      sf.replaceWithText(scriptContent);
    } else {
      sf = vueProject.createSourceFile(VIRTUAL_FILE, scriptContent);
    }

    for (const decl of sf.getImportDeclarations()) {
      const src = decl.getModuleSpecifierValue();
      const names: string[] = [...decl.getNamedImports().map((n) => n.getName())];
      const def = decl.getDefaultImport();
      if (def) names.push(def.getText());
      imports.push({ source: src, kind: classifyImport(src, mfRemoteNames), names });
    }

    // Named exports (Composition API helpers, utils)
    for (const [name] of sf.getExportedDeclarations()) {
      if (name !== 'default') {
        exports.push(name);
      }
    }

    // Options API default export
    const defaultExport = sf
      .getDescendantsOfKind(SyntaxKind.ExportAssignment)
      .find((ea) => !ea.isExportEquals());

    if (defaultExport) {
      const objLiteral = defaultExport.getFirstDescendantByKind(
        SyntaxKind.ObjectLiteralExpression
      );

      // Component name
      const nameProp = objLiteral
        ?.getProperty('name')
        ?.asKind(SyntaxKind.PropertyAssignment);
      const componentName = nameProp
        ?.getInitializer()
        ?.getText()
        ?.replace(/^['"]|['"]$/g, '');
      exports.push(componentName ?? 'default');

      if (objLiteral) {
        propsFields = extractVueProps(objLiteral);
        stateVars = extractVueData(sf, objLiteral);
        functionNames = extractVueMethods(objLiteral);
      }
    }

    // Composition API: ref / reactive / computed (runs alongside or instead of Options API)
    const compositionState = extractCompositionState(sf);
    if (compositionState.length) {
      stateVars = [...(stateVars ?? []), ...compositionState];
    }

    const compositionFns = extractCompositionFunctions(sf);
    if (compositionFns.length) {
      functionNames = [...(functionNames ?? []), ...compositionFns];
    }
  }

  return {
    relativePath,
    type: 'vue',
    exports,
    imports,
    ...(propsFields?.length && { propsFields }),
    ...(stateVars?.length && { stateVars }),
    ...(functionNames?.length && { functionNames }),
  };
}

// ── Vue Options API helpers ────────────────────────────────────────────────

import type { ObjectLiteralExpression } from 'ts-morph';

function extractVueProps(obj: ObjectLiteralExpression): string[] {
  const propsInit = obj
    .getProperty('props')
    ?.asKind(SyntaxKind.PropertyAssignment)
    ?.getInitializer()
    ?.asKind(SyntaxKind.ObjectLiteralExpression);
  if (!propsInit) return [];
  return getObjPropertyNames(propsInit);
}

function extractVueData(sf: SourceFile, obj: ObjectLiteralExpression): string[] {
  const dataProp = obj.getProperty('data');
  // data can be a MethodDeclaration or PropertyAssignment with function value
  const body =
    dataProp?.asKind(SyntaxKind.MethodDeclaration)?.getBody() ??
    dataProp
      ?.asKind(SyntaxKind.PropertyAssignment)
      ?.getInitializer()
      ?.asKind(SyntaxKind.FunctionExpression)
      ?.getBody();
  if (!body) return [];

  const returnObj = body
    .getDescendantsOfKind(SyntaxKind.ReturnStatement)[0]
    ?.getFirstDescendantByKind(SyntaxKind.ObjectLiteralExpression);
  if (!returnObj) return [];
  return getObjPropertyNames(returnObj);
}

function extractVueMethods(obj: ObjectLiteralExpression): string[] {
  const methodsInit = obj
    .getProperty('methods')
    ?.asKind(SyntaxKind.PropertyAssignment)
    ?.getInitializer()
    ?.asKind(SyntaxKind.ObjectLiteralExpression);
  if (!methodsInit) return [];
  return getObjPropertyNames(methodsInit);
}

// ── Vue Composition API helpers ────────────────────────────────────────────

function extractCompositionState(sf: SourceFile): string[] {
  const vars: string[] = [];

  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression().getText();

    // ref / shallowRef / computed → const x = ref(...)
    if (expr === 'ref' || expr === 'shallowRef' || expr === 'computed') {
      const varDecl = call.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
      if (!varDecl) continue;
      const nameNode = varDecl.getNameNode();
      if (nameNode.getKind() === SyntaxKind.Identifier) {
        vars.push(nameNode.getText());
      }
      continue;
    }

    // reactive / shallowReactive → const state = reactive({...})
    // or const { a, b } = reactive({...})
    if (expr === 'reactive' || expr === 'shallowReactive') {
      const varDecl = call.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
      if (!varDecl) continue;
      const nameNode = varDecl.getNameNode();

      if (nameNode.getKind() === SyntaxKind.Identifier) {
        vars.push(nameNode.getText());
      } else {
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

function extractCompositionFunctions(sf: SourceFile): string[] {
  const names = new Set<string>();

  // Regular function declarations (lowercase = not component)
  for (const fn of sf.getFunctions()) {
    const name = fn.getName();
    if (name && /^[a-z]/.test(name)) names.add(name);
  }

  // Arrow / function expressions assigned to variables
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

function getObjPropertyNames(obj: ObjectLiteralExpression): string[] {
  return obj
    .getProperties()
    .map(
      (p) =>
        p.asKind(SyntaxKind.PropertyAssignment)?.getName() ??
        p.asKind(SyntaxKind.ShorthandPropertyAssignment)?.getName() ??
        p.asKind(SyntaxKind.MethodDeclaration)?.getName()
    )
    .filter((n): n is string => !!n);
}
