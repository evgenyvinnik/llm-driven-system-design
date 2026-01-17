import { types } from 'recast';
import { TransformOptions, TransformResult } from './types.js';
export declare function transform({ ctx, source, node, }: TransformOptions): Promise<TransformResult>;
export declare function detectPreferredQuoteStyle(ast: types.ASTNode): "'" | '"';
