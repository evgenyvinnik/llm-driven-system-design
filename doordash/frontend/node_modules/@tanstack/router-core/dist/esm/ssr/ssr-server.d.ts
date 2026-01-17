import { DehydratedMatch } from './types.js';
import { AnyRouter } from '../router.js';
import { AnyRouteMatch } from '../Matches.js';
import { Manifest } from '../manifest.js';
declare module '../router' {
    interface ServerSsr {
        setRenderFinished: () => void;
        cleanup: () => void;
    }
    interface RouterEvents {
        onInjectedHtml: {
            type: 'onInjectedHtml';
        };
        onSerializationFinished: {
            type: 'onSerializationFinished';
        };
    }
}
export declare function dehydrateMatch(match: AnyRouteMatch): DehydratedMatch;
export declare function attachRouterServerSsrUtils({ router, manifest, }: {
    router: AnyRouter;
    manifest: Manifest | undefined;
}): void;
/**
 * Get the origin for the request.
 *
 * SECURITY: We intentionally do NOT trust the Origin header for determining
 * the router's origin. The Origin header can be spoofed by attackers, which
 * could lead to SSRF-like vulnerabilities where redirects are constructed
 * using a malicious origin (CVE-2024-34351).
 *
 * Instead, we derive the origin from request.url, which is typically set by
 * the server infrastructure (not client-controlled headers).
 *
 * For applications behind proxies that need to trust forwarded headers,
 * use the router's `origin` option to explicitly configure a trusted origin.
 */
export declare function getOrigin(request: Request): string;
