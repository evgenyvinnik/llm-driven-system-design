/**
 * @fileoverview Hair rendering components for the ReignsAvatar.
 * Includes both back hair (behind face) and top hair (in front) elements.
 */

import type { AvatarRenderContext } from './types';

/**
 * Props for hair rendering components.
 */
interface HairProps {
  /** Render context containing features and positioning */
  context: AvatarRenderContext;
}

/**
 * Renders the back portion of hair that appears behind the face.
 * Includes long hair, wavy hair with flowing curves, and braided hair with side braids.
 * This layer is rendered before the face to create depth.
 *
 * @param props - Component props with render context
 * @returns SVG group element with back hair paths, or null if bald
 */
export function BackHair({ context }: HairProps) {
  const { features, seed, cx, cy, faceWidth, faceHeight, size } = context;

  if (features.hairStyle === 'bald') {
    return null;
  }

  return (
    <g filter={`url(#paint-${seed})`}>
      {/* Long hair - full ellipse behind head */}
      {features.hairStyle === 'long' && (
        <ellipse
          cx={cx}
          cy={cy - size * 0.02}
          rx={faceWidth * 1.4}
          ry={faceHeight * 1.3}
          fill={`url(#hair-${seed})`}
        />
      )}

      {/* Wavy hair - flowing curves with volume */}
      {features.hairStyle === 'wavy' && (
        <path
          d={`M ${cx - faceWidth * 1.3} ${cy - faceHeight * 0.3}
              Q ${cx - faceWidth * 1.5} ${cy + faceHeight * 0.6}
                ${cx - faceWidth * 0.8} ${cy + faceHeight * 1.1}
              Q ${cx} ${cy + faceHeight * 1.3}
                ${cx + faceWidth * 0.8} ${cy + faceHeight * 1.1}
              Q ${cx + faceWidth * 1.5} ${cy + faceHeight * 0.6}
                ${cx + faceWidth * 1.3} ${cy - faceHeight * 0.3}
              Q ${cx} ${cy - faceHeight * 0.7}
                ${cx - faceWidth * 1.3} ${cy - faceHeight * 0.3} Z`}
          fill={`url(#hair-${seed})`}
        />
      )}

      {/* Braided hair - base with side braids */}
      {features.hairStyle === 'braided' && (
        <>
          {/* Base hair volume */}
          <ellipse
            cx={cx}
            cy={cy - size * 0.05}
            rx={faceWidth * 1.2}
            ry={faceHeight * 0.9}
            fill={`url(#hair-${seed})`}
          />
          {/* Left braid */}
          <path
            d={`M ${cx - faceWidth * 0.9} ${cy + faceHeight * 0.2}
                Q ${cx - faceWidth * 1.1} ${cy + faceHeight * 0.8}
                  ${cx - faceWidth * 0.7} ${cy + faceHeight * 1.2}
                Q ${cx - faceWidth * 0.5} ${cy + faceHeight * 0.9}
                  ${cx - faceWidth * 0.6} ${cy + faceHeight * 0.3}`}
            fill={features.hairColor.base}
            stroke={features.hairColor.highlight}
            strokeWidth="2"
          />
          {/* Right braid */}
          <path
            d={`M ${cx + faceWidth * 0.9} ${cy + faceHeight * 0.2}
                Q ${cx + faceWidth * 1.1} ${cy + faceHeight * 0.8}
                  ${cx + faceWidth * 0.7} ${cy + faceHeight * 1.2}
                Q ${cx + faceWidth * 0.5} ${cy + faceHeight * 0.9}
                  ${cx + faceWidth * 0.6} ${cy + faceHeight * 0.3}`}
            fill={features.hairColor.base}
            stroke={features.hairColor.highlight}
            strokeWidth="2"
          />
        </>
      )}
    </g>
  );
}

/**
 * Renders the top portion of hair that appears in front/on top of the face.
 * Different styles create distinct silhouettes from short cropped to flowing long hair.
 * This layer is rendered after the face and features.
 *
 * @param props - Component props with render context
 * @returns SVG group element with top hair paths, or null if bald
 */
export function TopHair({ context }: HairProps) {
  const { features, seed, cx, cy, faceWidth, faceHeight } = context;

  if (features.hairStyle === 'bald') {
    return null;
  }

  return (
    <g filter={`url(#paint-${seed})`}>
      {/* Short hair - compact ellipse on top of head */}
      {features.hairStyle === 'short' && (
        <ellipse
          cx={cx}
          cy={cy - faceHeight * 0.35}
          rx={faceWidth * 0.85}
          ry={faceHeight * 0.35}
          fill={`url(#hair-${seed})`}
        />
      )}

      {/* Medium hair - styled with volume on sides */}
      {features.hairStyle === 'medium' && (
        <path
          d={`M ${cx - faceWidth * 1.0} ${cy - faceHeight * 0.1}
              Q ${cx - faceWidth * 1.1} ${cy - faceHeight * 0.5}
                ${cx} ${cy - faceHeight * 0.55}
              Q ${cx + faceWidth * 1.1} ${cy - faceHeight * 0.5}
                ${cx + faceWidth * 1.0} ${cy - faceHeight * 0.1}
              Q ${cx + faceWidth * 0.5} ${cy - faceHeight * 0.15}
                ${cx} ${cy - faceHeight * 0.2}
              Q ${cx - faceWidth * 0.5} ${cy - faceHeight * 0.15}
                ${cx - faceWidth * 1.0} ${cy - faceHeight * 0.1} Z`}
          fill={`url(#hair-${seed})`}
        />
      )}

      {/* Long, wavy, and braided - fuller top hair */}
      {(features.hairStyle === 'long' ||
        features.hairStyle === 'wavy' ||
        features.hairStyle === 'braided') && (
        <path
          d={`M ${cx - faceWidth * 1.1} ${cy - faceHeight * 0.05}
              Q ${cx - faceWidth * 1.2} ${cy - faceHeight * 0.5}
                ${cx} ${cy - faceHeight * 0.6}
              Q ${cx + faceWidth * 1.2} ${cy - faceHeight * 0.5}
                ${cx + faceWidth * 1.1} ${cy - faceHeight * 0.05}
              Q ${cx + faceWidth * 0.5} ${cy - faceHeight * 0.15}
                ${cx} ${cy - faceHeight * 0.2}
              Q ${cx - faceWidth * 0.5} ${cy - faceHeight * 0.15}
                ${cx - faceWidth * 1.1} ${cy - faceHeight * 0.05} Z`}
          fill={`url(#hair-${seed})`}
        />
      )}
    </g>
  );
}
