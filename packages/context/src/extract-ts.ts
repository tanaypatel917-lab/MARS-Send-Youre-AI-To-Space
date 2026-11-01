import ts from "typescript";
import type { Definition, ExtractedFile, SymbolKind } from "./types";

export const TS_EXTRACTOR_VERSION = "ts-ast-v2";

const scriptKinds: Record<string, ts.ScriptKind> = {
  ".tsx": ts.ScriptKind.TSX,
  ".jsx": ts.ScriptKind.JSX,
  ".js": ts.ScriptKind.JS,
  ".mjs": ts.ScriptKind.JS,
  ".cjs": ts.ScriptKind.JS,
  ".mts": ts.ScriptKind.TS,
  ".cts": ts.ScriptKind.TS,
};

export function extractTypeScript(
  path: string,
  text: string,
  maxSymbols: number,
): ExtractedFile {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  const source = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKinds[extension] ?? ts.ScriptKind.TS,
  );
  const definitions: Array<{ node: ts.Node; definition: Definition }> = [];
  const nameNodes = new Set<ts.Node>();

  const add = (
    node: ts.Node,
    nameNode: ts.Node,
    kind: SymbolKind,
    depth: number,
    bodyNode?: ts.Node,
    stopAtInitializer = false,
  ) => {
    if (!ts.isIdentifier(nameNode)) return;
    nameNodes.add(nameNode);
    const name = nameNode.text;
    const signature = declarationSignature(
      source,
      node,
      bodyNode,
      name,
      kind,
      stopAtInitializer,
    );
    definitions.push({
      node,
      definition: {
        name,
        kind,
        line:
          source.getLineAndCharacterOfPosition(nameNode.getStart(source)).line +
          1,
        signature,
        depth,
      },
    });
  };

  const visit = (
    node: ts.Node,
    depth: number,
    scope: "top" | "namespace" | "class" | "other",
  ) => {
    const declarationScope = scope === "top" || scope === "namespace";
    if (ts.isFunctionDeclaration(node) && node.name && declarationScope) {
      add(node, node.name, "function", depth, node.body);
    } else if (ts.isClassDeclaration(node) && node.name && declarationScope) {
      add(node, node.name, "class", depth, node.members[0]);
      node.members.forEach((member) => {
        visit(member, depth + 1, "class");
      });
    } else if (ts.isInterfaceDeclaration(node) && declarationScope) {
      add(node, node.name, "interface", depth, node.members[0]);
      node.members.forEach((member) => {
        visit(member, depth + 1, "class");
      });
    } else if (ts.isTypeAliasDeclaration(node) && declarationScope) {
      add(node, node.name, "type", depth);
    } else if (ts.isEnumDeclaration(node) && declarationScope) {
      add(node, node.name, "enum", depth, node.members[0]);
    } else if (ts.isModuleDeclaration(node) && declarationScope) {
      if (ts.isIdentifier(node.name)) add(node, node.name, "namespace", depth);
      if (node.body) {
        if (ts.isModuleBlock(node.body)) {
          node.body.statements.forEach((statement) => {
            visit(statement, depth + 1, "namespace");
          });
        } else {
          visit(node.body, depth + 1, "namespace");
        }
      }
    } else if (
      ts.isMethodDeclaration(node) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      scope === "class"
    ) {
      add(node, node.name, "method", depth, node.body);
    } else if (
      (ts.isPropertyDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      scope === "class" &&
      !node.name.text.startsWith("#")
    ) {
      const kind = ts.isPropertyDeclaration(node) ? "property" : "method";
      add(
        node,
        node.name,
        kind,
        depth,
        ts.isPropertyDeclaration(node) ? undefined : node.body,
        ts.isPropertyDeclaration(node),
      );
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const parentList = node.parent;
      const parent = parentList.parent.parent;
      const isAllowed =
        (scope === "top" && ts.isSourceFile(parent)) ||
        (scope === "namespace" && ts.isModuleBlock(parent));
      if (isAllowed) {
        const initializer = node.initializer;
        const kind =
          initializer &&
          (ts.isArrowFunction(initializer) ||
            ts.isFunctionExpression(initializer))
            ? "function"
            : initializer && ts.isClassExpression(initializer)
              ? "class"
              : "variable";
        const signatureBody =
          initializer && ts.isClassExpression(initializer)
            ? initializer.members[0]
            : initializer &&
                (ts.isArrowFunction(initializer) ||
                  ts.isFunctionExpression(initializer))
              ? initializer.body
              : initializer;
        add(node, node.name, kind, depth, signatureBody, true);
        if (initializer && ts.isClassExpression(initializer)) {
          initializer.members.forEach((member) => {
            visit(member, depth + 1, "class");
          });
        }
      }
    }

    if (
      ts.isSourceFile(node) ||
      (ts.isBlock(node) && scope === "top") ||
      (ts.isModuleBlock(node) && scope === "namespace") ||
      ts.isVariableStatement(node) ||
      ts.isVariableDeclarationList(node)
    ) {
      ts.forEachChild(node, (child) => visit(child, depth, scope));
      return;
    }
    if (
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isModuleDeclaration(node) ||
      ts.isClassExpression(node)
    ) {
      return;
    }
    ts.forEachChild(node, (child) => visit(child, depth, "other"));
  };
  visit(source, 0, "top");

  const refs = new Map<string, number>();
  const collectRefs = (node: ts.Node) => {
    if (ts.isIdentifier(node) && !nameNodes.has(node)) {
      refs.set(node.text, (refs.get(node.text) ?? 0) + 1);
    }
    ts.forEachChild(node, collectRefs);
  };
  collectRefs(source);

  const sortedDefinitions = definitions.sort(
    (left, right) => left.definition.line - right.definition.line,
  );
  return {
    defs: sortedDefinitions
      .slice(0, maxSymbols)
      .map(({ definition }) => definition),
    refs,
    droppedSymbols: Math.max(0, sortedDefinitions.length - maxSymbols),
  };
}

function declarationSignature(
  source: ts.SourceFile,
  node: ts.Node,
  bodyNode: ts.Node | undefined,
  name: string,
  kind: SymbolKind,
  stopAtInitializer: boolean,
): string {
  const start = node.getStart(source);
  let end = node.end;
  if (bodyNode) end = bodyNode.getStart(source);
  else if (
    stopAtInitializer &&
    ts.isVariableDeclaration(node) &&
    node.initializer
  ) {
    end = node.initializer.getStart(source);
  } else if (
    stopAtInitializer &&
    ts.isPropertyDeclaration(node) &&
    node.initializer
  ) {
    end = node.initializer.getStart(source);
  }
  if (
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isEnumDeclaration(node)
  ) {
    end = Math.max(start, node.members.pos - 1);
  }
  let signature = source.text.slice(start, end).replace(/\s+/g, " ").trim();
  signature = signature.replace(/\s*\{\s*$/, "").trim();
  if (!signature) signature = `${kind} ${name}`;
  if (signature.length > 160) {
    const fallback = `${kind} ${name}`;
    if (fallback.length > 160) return fallback;
    let prefix = signature.slice(0, 159);
    if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
    if (!prefix.includes(name)) return fallback;
    signature = `${prefix}…`;
  }
  return signature;
}
