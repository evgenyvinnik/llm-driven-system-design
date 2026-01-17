import { parseAst } from "@tanstack/router-utils";
import { parse, visit, types, print } from "recast";
import { SourceMapConsumer } from "source-map";
import { mergeImportDeclarations } from "../utils.js";
import { ensureStringArgument } from "./utils.js";
const b = types.builders;
async function transform({
  ctx,
  source,
  node
}) {
  let appliedChanges = false;
  let ast;
  try {
    ast = parse(source, {
      sourceFileName: "output.ts",
      parser: {
        parse(code) {
          return parseAst({
            code,
            // we need to instruct babel to produce tokens,
            // otherwise recast will try to generate the tokens via its own parser and will fail
            tokens: true
          });
        }
      }
    });
  } catch (e) {
    console.error("Error parsing code", ctx.routeId, source, e);
    return {
      result: "error",
      error: e
    };
  }
  const preferredQuote = detectPreferredQuoteStyle(ast);
  let routeExportHandled = false;
  function onExportFound(decl) {
    if (decl.init?.type === "CallExpression") {
      const callExpression = decl.init;
      const firstArgument = callExpression.arguments[0];
      if (firstArgument) {
        if (firstArgument.type === "ObjectExpression") {
          const staticProperties = firstArgument.properties.flatMap((p) => {
            if (p.type === "ObjectProperty" && p.key.type === "Identifier") {
              return p.key.name;
            }
            return [];
          });
          node.createFileRouteProps = new Set(staticProperties);
        }
      }
      let identifier;
      if (callExpression.callee.type === "Identifier") {
        identifier = callExpression.callee;
        if (ctx.verboseFileRoutes) {
          callExpression.callee = b.callExpression(identifier, [
            b.stringLiteral(ctx.routeId)
          ]);
          appliedChanges = true;
        }
      } else if (callExpression.callee.type === "CallExpression" && callExpression.callee.callee.type === "Identifier") {
        identifier = callExpression.callee.callee;
        if (!ctx.verboseFileRoutes) {
          callExpression.callee = identifier;
          appliedChanges = true;
        } else {
          appliedChanges = ensureStringArgument(
            callExpression.callee,
            ctx.routeId,
            ctx.preferredQuote
          );
        }
      }
      if (identifier === void 0) {
        throw new Error(
          `expected identifier to be present in ${ctx.routeId} for export "Route"`
        );
      }
      if (identifier.name === "createFileRoute" && ctx.lazy) {
        identifier.name = "createLazyFileRoute";
        appliedChanges = true;
      } else if (identifier.name === "createLazyFileRoute" && !ctx.lazy) {
        identifier.name = "createFileRoute";
        appliedChanges = true;
      }
    } else {
      throw new Error(
        `expected "Route" export to be initialized by a CallExpression`
      );
    }
    routeExportHandled = true;
  }
  const program = ast.program;
  for (const n of program.body) {
    if (n.type === "ExportNamedDeclaration") {
      if (n.declaration?.type === "VariableDeclaration") {
        const decl = n.declaration.declarations[0];
        if (decl && decl.type === "VariableDeclarator" && decl.id.type === "Identifier") {
          if (decl.id.name === "Route") {
            onExportFound(decl);
          }
        }
      } else if (n.declaration === null && n.specifiers) {
        for (const spec of n.specifiers) {
          if (typeof spec.exported.name === "string") {
            if (spec.exported.name === "Route") {
              const variableName = spec.local?.name || spec.exported.name;
              for (const decl of program.body) {
                if (decl.type === "VariableDeclaration" && decl.declarations[0]) {
                  const variable = decl.declarations[0];
                  if (variable.type === "VariableDeclarator" && variable.id.type === "Identifier" && variable.id.name === variableName) {
                    onExportFound(variable);
                    break;
                  }
                }
              }
            }
          }
        }
      }
    }
    if (routeExportHandled) {
      break;
    }
  }
  if (!routeExportHandled) {
    return {
      result: "no-route-export"
    };
  }
  const imports = {
    required: [],
    banned: []
  };
  const targetModule = `@tanstack/${ctx.target}-router`;
  if (ctx.verboseFileRoutes === false) {
    imports.banned = [
      {
        source: targetModule,
        specifiers: [
          { imported: "createLazyFileRoute" },
          { imported: "createFileRoute" }
        ]
      }
    ];
  } else {
    if (ctx.lazy) {
      imports.required = [
        {
          source: targetModule,
          specifiers: [{ imported: "createLazyFileRoute" }]
        }
      ];
      imports.banned = [
        {
          source: targetModule,
          specifiers: [{ imported: "createFileRoute" }]
        }
      ];
    } else {
      imports.required = [
        {
          source: targetModule,
          specifiers: [{ imported: "createFileRoute" }]
        }
      ];
      imports.banned = [
        {
          source: targetModule,
          specifiers: [{ imported: "createLazyFileRoute" }]
        }
      ];
    }
  }
  imports.required = mergeImportDeclarations(imports.required);
  imports.banned = mergeImportDeclarations(imports.banned);
  const importStatementCandidates = [];
  const importDeclarationsToRemove = [];
  for (const n of program.body) {
    const findImport = (opts) => (i) => {
      if (i.source === opts.source) {
        const importKind = i.importKind || "value";
        const expectedImportKind = opts.importKind || "value";
        return expectedImportKind === importKind;
      }
      return false;
    };
    if (n.type === "ImportDeclaration" && typeof n.source.value === "string") {
      const filterImport = findImport({
        source: n.source.value,
        importKind: n.importKind
      });
      let requiredImports = imports.required.filter(filterImport)[0];
      const bannedImports = imports.banned.filter(filterImport)[0];
      if (!requiredImports && !bannedImports) {
        continue;
      }
      const importSpecifiersToRemove = [];
      if (n.specifiers) {
        for (const spec of n.specifiers) {
          if (!requiredImports && !bannedImports) {
            break;
          }
          if (spec.type === "ImportSpecifier" && typeof spec.imported.name === "string") {
            if (requiredImports) {
              const requiredImportIndex = requiredImports.specifiers.findIndex(
                (imp) => imp.imported === spec.imported.name
              );
              if (requiredImportIndex !== -1) {
                requiredImports.specifiers.splice(requiredImportIndex, 1);
                if (requiredImports.specifiers.length === 0) {
                  imports.required = imports.required.splice(
                    imports.required.indexOf(requiredImports),
                    1
                  );
                  requiredImports = void 0;
                }
              } else {
                importStatementCandidates.push(n);
              }
            }
            if (bannedImports) {
              const bannedImportIndex = bannedImports.specifiers.findIndex(
                (imp) => imp.imported === spec.imported.name
              );
              if (bannedImportIndex !== -1) {
                importSpecifiersToRemove.push(spec);
              }
            }
          }
        }
        if (importSpecifiersToRemove.length > 0) {
          appliedChanges = true;
          n.specifiers = n.specifiers.filter(
            (spec) => !importSpecifiersToRemove.includes(spec)
          );
          if (n.specifiers.length === 0) {
            importDeclarationsToRemove.push(n);
          }
        }
      }
    }
  }
  imports.required.forEach((requiredImport) => {
    if (requiredImport.specifiers.length > 0) {
      appliedChanges = true;
      if (importStatementCandidates.length > 0) {
        const importStatement2 = importStatementCandidates.find(
          (importStatement3) => {
            if (importStatement3.source.value === requiredImport.source) {
              const importKind = importStatement3.importKind || "value";
              const requiredImportKind = requiredImport.importKind || "value";
              return importKind === requiredImportKind;
            }
            return false;
          }
        );
        if (importStatement2) {
          if (importStatement2.specifiers === void 0) {
            importStatement2.specifiers = [];
          }
          const importSpecifiersToAdd = requiredImport.specifiers.map(
            (spec) => b.importSpecifier(
              b.identifier(spec.imported),
              b.identifier(spec.imported)
            )
          );
          importStatement2.specifiers = [
            ...importStatement2.specifiers,
            ...importSpecifiersToAdd
          ];
          return;
        }
      }
      const importStatement = b.importDeclaration(
        requiredImport.specifiers.map(
          (spec) => b.importSpecifier(
            b.identifier(spec.imported),
            spec.local ? b.identifier(spec.local) : null
          )
        ),
        b.stringLiteral(requiredImport.source)
      );
      program.body.unshift(importStatement);
    }
  });
  if (importDeclarationsToRemove.length > 0) {
    appliedChanges = true;
    for (const importDeclaration of importDeclarationsToRemove) {
      if (importDeclaration.specifiers?.length === 0) {
        const index = program.body.indexOf(importDeclaration);
        if (index !== -1) {
          program.body.splice(index, 1);
        }
      }
    }
  }
  if (!appliedChanges) {
    return {
      result: "not-modified"
    };
  }
  const printResult = print(ast, {
    reuseWhitespace: true,
    sourceMapName: "output.map"
  });
  let transformedCode = printResult.code;
  if (printResult.map) {
    const fixedOutput = await fixTransformedOutputText({
      originalCode: source,
      transformedCode,
      sourceMap: printResult.map,
      preferredQuote
    });
    transformedCode = fixedOutput;
  }
  return {
    result: "modified",
    output: transformedCode
  };
}
async function fixTransformedOutputText({
  originalCode,
  transformedCode,
  sourceMap,
  preferredQuote
}) {
  const originalLines = originalCode.split("\n");
  const transformedLines = transformedCode.split("\n");
  const defaultUsesSemicolons = detectSemicolonUsage(originalCode);
  const consumer = await new SourceMapConsumer(sourceMap);
  const fixedLines = transformedLines.map((line, i) => {
    const transformedLineNum = i + 1;
    let origLineText = void 0;
    for (let col = 0; col < line.length; col++) {
      const mapped = consumer.originalPositionFor({
        line: transformedLineNum,
        column: col
      });
      if (mapped.line != null && mapped.line > 0) {
        origLineText = originalLines[mapped.line - 1];
        break;
      }
    }
    if (origLineText !== void 0) {
      if (origLineText === line) {
        return origLineText;
      }
      return fixLine(line, {
        originalLine: origLineText,
        useOriginalSemicolon: true,
        useOriginalQuotes: true,
        fallbackQuote: preferredQuote
      });
    } else {
      return fixLine(line, {
        originalLine: null,
        useOriginalSemicolon: false,
        useOriginalQuotes: false,
        fallbackQuote: preferredQuote,
        fallbackSemicolon: defaultUsesSemicolons
      });
    }
  });
  return fixedLines.join("\n");
}
function fixLine(line, {
  originalLine,
  useOriginalSemicolon,
  useOriginalQuotes,
  fallbackQuote,
  fallbackSemicolon = true
}) {
  let result = line;
  if (useOriginalQuotes && originalLine) {
    result = fixQuotes(result, originalLine, fallbackQuote);
  } else if (!useOriginalQuotes && fallbackQuote) {
    result = fixQuotesToPreferred(result, fallbackQuote);
  }
  if (useOriginalSemicolon && originalLine) {
    const hadSemicolon = originalLine.trimEnd().endsWith(";");
    const hasSemicolon = result.trimEnd().endsWith(";");
    if (hadSemicolon && !hasSemicolon) result += ";";
    if (!hadSemicolon && hasSemicolon) result = result.replace(/;\s*$/, "");
  } else if (!useOriginalSemicolon) {
    const hasSemicolon = result.trimEnd().endsWith(";");
    if (!fallbackSemicolon && hasSemicolon) result = result.replace(/;\s*$/, "");
    if (fallbackSemicolon && !hasSemicolon && result.trim()) result += ";";
  }
  return result;
}
function fixQuotes(line, originalLine, fallbackQuote) {
  let originalQuote = detectQuoteFromLine(originalLine);
  if (!originalQuote) {
    originalQuote = fallbackQuote;
  }
  return fixQuotesToPreferred(line, originalQuote);
}
function fixQuotesToPreferred(line, quote) {
  return line.replace(
    /(['"`])([^'"`\\]*(?:\\.[^'"`\\]*)*)\1/g,
    (_, q, content) => {
      const escaped = content.replaceAll(quote, `\\${quote}`);
      return `${quote}${escaped}${quote}`;
    }
  );
}
function detectQuoteFromLine(line) {
  const match = line.match(/(['"`])(?:\\.|[^\\])*?\1/);
  return match ? match[1] : null;
}
function detectSemicolonUsage(code) {
  const lines = code.split("\n").map((l) => l.trim());
  const total = lines.length;
  const withSemis = lines.filter((l) => l.endsWith(";")).length;
  return withSemis > total / 2;
}
function detectPreferredQuoteStyle(ast) {
  let single = 0;
  let double = 0;
  visit(ast, {
    visitStringLiteral(path) {
      if (path.parent.node.type !== "JSXAttribute") {
        const raw = path.node.extra?.raw;
        if (raw?.startsWith("'")) single++;
        else if (raw?.startsWith('"')) double++;
      }
      return false;
    }
  });
  if (single >= double) {
    return "'";
  }
  return '"';
}
export {
  detectPreferredQuoteStyle,
  transform
};
//# sourceMappingURL=transform.js.map
