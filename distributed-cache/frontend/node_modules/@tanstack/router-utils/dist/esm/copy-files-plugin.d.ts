import { Plugin } from 'vite';
export declare function copyFilesPlugin({ fromDir, toDir, pattern, }: {
    pattern?: string | Array<string>;
    fromDir: string;
    toDir: string;
}): Plugin;
