import { GLOBAL_SEROVAL, GLOBAL_TSR } from './constants.cjs';
import { TsrSsrGlobal } from './types.cjs';
import { AnyRouter } from '../router.cjs';
declare global {
    interface Window {
        [GLOBAL_TSR]?: TsrSsrGlobal;
        [GLOBAL_SEROVAL]?: any;
    }
}
export declare function hydrate(router: AnyRouter): Promise<any>;
