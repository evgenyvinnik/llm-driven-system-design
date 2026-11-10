/**
 * Exposure is logged where the variant renders, not where it is assigned.
 *
 *   <Exposure evaluation={cta}>…</Exposure>              logs on mount
 *   <Exposure evaluation={cta} whenVisible>…</Exposure>  logs once ≥50% is in the viewport
 *   <Experiment flag="checkout_cta" variants={{ control: <A/>, treatment: <B/> }} />
 *
 * A unit that was assigned but never reached this component (the tab was
 * never opened, the element never scrolled into view) produces no exposure.
 */
import { useEffect, useRef, type ReactNode } from 'react'
import type { Evaluation } from '../core/types.js'
import { useClientState, useExperimentClient } from './context.js'
import { useVariant } from './hooks.js'

export interface ExposureProps {
  evaluation: Evaluation
  children: ReactNode
  whenVisible?: boolean
  /** Visible fraction that counts as seen (default 0.5). */
  threshold?: number
}

export function Exposure({ evaluation, children, whenVisible = false, threshold = 0.5 }: ExposureProps) {
  const client = useExperimentClient()
  const { context } = useClientState()
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!whenVisible) {
      client.logExposure(evaluation, context)
      return
    }
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') {
      client.logExposure(evaluation, context)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting && e.intersectionRatio >= threshold)) {
          client.logExposure(evaluation, context)
          observer.disconnect()
        }
      },
      { threshold },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [client, evaluation, context, whenVisible, threshold])

  return whenVisible ? (
    <div ref={ref} data-exposure={evaluation.key}>
      {children}
    </div>
  ) : (
    <>{children}</>
  )
}

export interface ExperimentProps {
  flag: string
  variants: Record<string, ReactNode>
  /** Rendered when the variant has no entry (e.g. a coded default with no UI). */
  fallback?: ReactNode
  whenVisible?: boolean
}

export function Experiment({ flag, variants, fallback = null, whenVisible }: ExperimentProps) {
  const evaluation = useVariant(flag)
  const node = evaluation.variant !== null ? variants[evaluation.variant] : undefined
  if (node === undefined) return <>{fallback}</>
  return (
    <Exposure evaluation={evaluation} whenVisible={whenVisible}>
      {node}
    </Exposure>
  )
}
