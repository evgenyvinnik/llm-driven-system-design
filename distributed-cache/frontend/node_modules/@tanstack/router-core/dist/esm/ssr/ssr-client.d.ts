import { GLOBAL_SEROVAL, GLOBAL_TSR } from './constants.js';
import { TsrSsrGlobal } from './types.js';
import { AnyRouter } from '../router.js';
declare global {
    interface Window {
        [GLOBAL_TSR]?: TsrSsrGlobal;
        [GLOBAL_SEROVAL]?: any;
    }
}
export declare function hydrate(router: AnyRouter): Promise<any>;
