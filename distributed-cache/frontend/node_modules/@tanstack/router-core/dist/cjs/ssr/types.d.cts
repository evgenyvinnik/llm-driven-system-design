import { Manifest } from '../manifest.cjs';
import { MakeRouteMatch } from '../Matches.cjs';
export interface DehydratedMatch {
    i: MakeRouteMatch['id'];
    b?: MakeRouteMatch['__beforeLoadContext'];
    l?: MakeRouteMatch['loaderData'];
    e?: MakeRouteMatch['error'];
    u: MakeRouteMatch['updatedAt'];
    s: MakeRouteMatch['status'];
    ssr?: MakeRouteMatch['ssr'];
}
export interface DehydratedRouter {
    manifest: Manifest | undefined;
    dehydratedData?: any;
    lastMatchId?: string;
    matches: Array<DehydratedMatch>;
}
export interface TsrSsrGlobal {
    router?: DehydratedRouter;
    h: () => void;
    e: () => void;
    c: () => void;
    p: (script: () => void) => void;
    buffer: Array<() => void>;
    t?: Map<string, (value: any) => any>;
    initialized?: boolean;
    hydrated?: boolean;
    streamEnded?: boolean;
}
