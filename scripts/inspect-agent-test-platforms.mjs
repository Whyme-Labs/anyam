import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

// Inspect registration options only. Never import or execute the test module,
// override process.platform, or imply that another platform's assertions ran.
const platform = process.argv[2] ?? process.platform;
assert.ok(["darwin", "linux", "win32", "aix", "freebsd", "openbsd", "sunos", "android"].includes(platform), "expected a Node platform name");
const pathname = "test/agent-cli.test.ts";
const source = ts.createSourceFile(pathname, await readFile(pathname, "utf8"), ts.ScriptTarget.Latest, true);
const tests = [];
for (const statement of source.statements) {
  if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue;
  const call = statement.expression;
  if (call.expression.getText(source) !== "test") continue;
  assert.ok(ts.isStringLiteral(call.arguments[0]), "test names must be static strings");
  const name = call.arguments[0].text;
  let requiredPlatform = null;
  let reason = null;
  if (call.arguments.length === 3) {
    const options = call.arguments[1];
    assert.ok(ts.isObjectLiteralExpression(options), `unsupported options in ${name}`);
    assert.equal(options.properties.length, 1, `inspect new test options explicitly: ${name}`);
    const property = options.properties[0];
    assert.ok(ts.isPropertyAssignment(property) && property.name.getText(source) === "skip", `unsupported registration option in ${name}`);
    const skip = property.initializer;
    assert.ok(ts.isConditionalExpression(skip), `skip must be a static platform condition: ${name}`);
    const condition = skip.condition;
    assert.ok(ts.isBinaryExpression(condition) && condition.left.getText(source) === "process.platform" && condition.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken && ts.isStringLiteral(condition.right), `unsupported platform condition in ${name}`);
    assert.ok(ts.isStringLiteral(skip.whenTrue) && skip.whenFalse.kind === ts.SyntaxKind.FalseKeyword, `unsupported skip result in ${name}`);
    requiredPlatform = condition.right.text;
    reason = skip.whenTrue.text;
  } else {
    assert.equal(call.arguments.length, 2, `unsupported test registration in ${name}`);
  }
  tests.push({ name, requiredPlatform, selection: requiredPlatform && requiredPlatform !== platform ? "skipped" : "selected", reason: requiredPlatform && requiredPlatform !== platform ? reason : null });
}
assert.ok(tests.length > 0, "no test registrations found");
console.log(JSON.stringify({ protocol: "anyam.agent-test-platform-selection/v1", file: pathname, inspectedPlatform: platform, hostPlatform: process.platform, execution: "not-performed; static-registration-inspection-only", registered: tests.length, selected: tests.filter(t => t.selection === "selected").length, skipped: tests.filter(t => t.selection === "skipped").length, tests }, null, 2));
