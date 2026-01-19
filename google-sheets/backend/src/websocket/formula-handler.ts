/**
 * Formula evaluation handler for spreadsheet calculations.
 *
 * @description Provides basic formula support for spreadsheet cells.
 * Handles common functions like SUM, AVERAGE, COUNT, MIN, and MAX,
 * as well as simple arithmetic expressions. This is a demo implementation;
 * production systems should use HyperFormula for full Excel compatibility.
 *
 * @module websocket/formula-handler
 */

import {
  formulaCalculationsTotal,
  formulaCalculationDuration,
} from '../shared/metrics.js';

/**
 * Evaluates simple spreadsheet formulas.
 *
 * @description Evaluates cell values that start with '=' as formulas.
 * Supports basic functions (SUM, AVERAGE, COUNT, MIN, MAX) and arithmetic.
 * Non-formula values are returned unchanged. Tracks formula calculation
 * metrics for monitoring.
 *
 * @param {string} value - The cell value (may or may not be a formula)
 * @returns {string} The computed result, the original value if not a formula, or '#ERROR' on failure
 *
 * @example
 * ```typescript
 * evaluateFormula('Hello');        // Returns 'Hello' (not a formula)
 * evaluateFormula('=SUM(1,2,3)');  // Returns '6'
 * evaluateFormula('=5+3*2');       // Returns '11'
 * evaluateFormula('=INVALID');     // Returns '#ERROR'
 * ```
 */
export function evaluateFormula(value: string): string {
  // If not a formula, return as-is
  if (!value || !value.startsWith('=')) {
    return value;
  }

  // Record formula calculation metrics
  formulaCalculationsTotal.inc();
  const start = Date.now();

  try {
    const result = evaluateFormulaExpression(value);
    formulaCalculationDuration.observe(Date.now() - start);
    return result;
  } catch {
    formulaCalculationDuration.observe(Date.now() - start);
    return '#ERROR';
  }
}

/**
 * Internal formula expression evaluator.
 *
 * @description Handles the actual computation of formula expressions.
 * Parses the formula syntax and delegates to specific function handlers
 * or evaluates arithmetic expressions directly.
 *
 * @param {string} formula - The formula string starting with '='
 * @returns {string} The computed result as a string
 * @throws {Error} If the formula syntax is invalid or evaluation fails
 *
 * @example
 * ```typescript
 * evaluateFormulaExpression('=SUM(1,2,3)');  // Returns '6'
 * evaluateFormulaExpression('=10/2');        // Returns '5'
 * ```
 */
function evaluateFormulaExpression(formula: string): string {
  // Remove the = prefix
  const expr = formula.slice(1).toUpperCase();

  // Handle SUM function, e.g., =SUM(1,2,3)
  if (expr.startsWith('SUM(') && expr.endsWith(')')) {
    return evaluateSum(expr);
  }

  // Handle AVERAGE function, e.g., =AVERAGE(1,2,3)
  if (expr.startsWith('AVERAGE(') && expr.endsWith(')')) {
    return evaluateAverage(expr);
  }

  // Handle COUNT function, e.g., =COUNT(1,2,3)
  if (expr.startsWith('COUNT(') && expr.endsWith(')')) {
    return evaluateCount(expr);
  }

  // Handle MIN function, e.g., =MIN(1,2,3)
  if (expr.startsWith('MIN(') && expr.endsWith(')')) {
    return evaluateMin(expr);
  }

  // Handle MAX function, e.g., =MAX(1,2,3)
  if (expr.startsWith('MAX(') && expr.endsWith(')')) {
    return evaluateMax(expr);
  }

  // Handle simple arithmetic (unsafe in production - use proper parser)
  const result = Function(`"use strict"; return (${formula.slice(1)})`)();
  return String(result);
}

/**
 * Evaluates a SUM function.
 *
 * @description Calculates the sum of all numeric values in the argument list.
 * Non-numeric values are filtered out.
 *
 * @param {string} expr - The SUM expression, e.g., "SUM(1,2,3)"
 * @returns {string} The sum of all values as a string
 *
 * @example
 * ```typescript
 * evaluateSum('SUM(1,2,3)');    // Returns '6'
 * evaluateSum('SUM(10,20)');    // Returns '30'
 * ```
 */
function evaluateSum(expr: string): string {
  const inner = expr.slice(4, -1);
  const nums = parseNumberList(inner);
  return nums.reduce((a, b) => a + b, 0).toString();
}

/**
 * Evaluates an AVERAGE function.
 *
 * @description Calculates the arithmetic mean of all numeric values in the argument list.
 * Returns '#DIV/0!' if the list is empty to match Excel behavior.
 *
 * @param {string} expr - The AVERAGE expression, e.g., "AVERAGE(1,2,3)"
 * @returns {string} The average of all values as a string, or '#DIV/0!' if empty
 *
 * @example
 * ```typescript
 * evaluateAverage('AVERAGE(2,4,6)');  // Returns '4'
 * evaluateAverage('AVERAGE()');       // Returns '#DIV/0!'
 * ```
 */
function evaluateAverage(expr: string): string {
  const inner = expr.slice(8, -1);
  const nums = parseNumberList(inner);
  if (nums.length === 0) return '#DIV/0!';
  const sum = nums.reduce((a, b) => a + b, 0);
  return (sum / nums.length).toString();
}

/**
 * Evaluates a COUNT function.
 *
 * @description Counts the number of numeric values in the argument list.
 * Non-numeric values are not counted.
 *
 * @param {string} expr - The COUNT expression, e.g., "COUNT(1,2,3)"
 * @returns {string} The count of numeric values as a string
 *
 * @example
 * ```typescript
 * evaluateCount('COUNT(1,2,3)');      // Returns '3'
 * evaluateCount('COUNT(1,a,2)');      // Returns '2' (only numbers counted)
 * ```
 */
function evaluateCount(expr: string): string {
  const inner = expr.slice(6, -1);
  const nums = parseNumberList(inner);
  return nums.length.toString();
}

/**
 * Evaluates a MIN function.
 *
 * @description Finds the minimum value among all numeric values in the argument list.
 * Returns '#VALUE!' if the list is empty.
 *
 * @param {string} expr - The MIN expression, e.g., "MIN(1,2,3)"
 * @returns {string} The minimum value as a string, or '#VALUE!' if empty
 *
 * @example
 * ```typescript
 * evaluateMin('MIN(5,2,8)');   // Returns '2'
 * evaluateMin('MIN()');        // Returns '#VALUE!'
 * ```
 */
function evaluateMin(expr: string): string {
  const inner = expr.slice(4, -1);
  const nums = parseNumberList(inner);
  if (nums.length === 0) return '#VALUE!';
  return Math.min(...nums).toString();
}

/**
 * Evaluates a MAX function.
 *
 * @description Finds the maximum value among all numeric values in the argument list.
 * Returns '#VALUE!' if the list is empty.
 *
 * @param {string} expr - The MAX expression, e.g., "MAX(1,2,3)"
 * @returns {string} The maximum value as a string, or '#VALUE!' if empty
 *
 * @example
 * ```typescript
 * evaluateMax('MAX(5,2,8)');   // Returns '8'
 * evaluateMax('MAX()');        // Returns '#VALUE!'
 * ```
 */
function evaluateMax(expr: string): string {
  const inner = expr.slice(4, -1);
  const nums = parseNumberList(inner);
  if (nums.length === 0) return '#VALUE!';
  return Math.max(...nums).toString();
}

/**
 * Parses a comma-separated list of numbers.
 *
 * @description Splits the input string by commas, parses each part as a float,
 * and filters out any NaN values. Used by formula functions to extract
 * numeric arguments.
 *
 * @param {string} input - Comma-separated string of numbers, e.g., "1, 2, 3"
 * @returns {number[]} Array of parsed numbers (NaN values filtered out)
 *
 * @example
 * ```typescript
 * parseNumberList('1, 2, 3');      // Returns [1, 2, 3]
 * parseNumberList('1, abc, 3');    // Returns [1, 3]
 * parseNumberList('');             // Returns []
 * ```
 */
function parseNumberList(input: string): number[] {
  return input
    .split(',')
    .map(n => parseFloat(n.trim()))
    .filter(n => !isNaN(n));
}
