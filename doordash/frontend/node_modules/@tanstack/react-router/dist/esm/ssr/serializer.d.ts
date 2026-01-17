import type * as React from 'react';
declare module '@tanstack/router-core' {
    interface SerializerExtensions {
        ReadableStream: React.JSX.Element;
    }
}
