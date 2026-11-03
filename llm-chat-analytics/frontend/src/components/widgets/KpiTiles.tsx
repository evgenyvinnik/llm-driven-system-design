/**
 * KPI tiles for the whole range. Each is computed over the range as one window
 * (distinct users merged from sketches, not summed per day), and compared with
 * the previous period cut at the same elapsed moment, so a range that includes
 * today is never compared with a full previous week.
 */
import type { UseQueryResult } from "@tanstack/react-query";
import type { OverviewResponse, Tile } from "../../lib/api";
import { formatDelta, formatValue, localTime } from "../../lib/format";
import { EyeOffIcon, InfoIcon } from "../icons";
import { WidgetFrame } from "./WidgetFrame";

interface Props {
  query: UseQueryResult<OverviewResponse>;
  timeZone: string;
  compareLabel: string | null;
  activeMetric: string;
  onSelectMetric: (id: string) => void;
}

export function KpiTiles({
  query,
  timeZone,
  compareLabel,
  activeMetric,
  onSelectMetric,
}: Props) {
  return (
    <WidgetFrame
      title="Summary"
      query={query}
      minHeight={96}
      testId="kpi-tiles"
      subtitle={
        query.data && (
          <>
            {localTime(query.data.window.from, timeZone, "MMM d")} –{" "}
            {localTime(query.data.window.cutoff, timeZone, "MMM d, HH:mm")}
            {query.data.comparison && compareLabel && (
              <span className="text-ink-muted">
                {" "}
                · vs {localTime(
                  query.data.comparison.from,
                  timeZone,
                  "MMM d",
                )}{" "}
                –{" "}
                {localTime(query.data.comparison.to, timeZone, "MMM d, HH:mm")}
              </span>
            )}
          </>
        )
      }
      actions={
        query.data?.partial && (
          <span className="badge bg-plane text-ink-2">
            Partial · includes the open period
          </span>
        )
      }
    >
      {(data) => (
        <>
          {data.suppressed && (
            <p className="mb-2 flex items-center gap-1.5 text-xs text-ink-2">
              <EyeOffIcon className="h-3.5 w-3.5" /> Fewer than{" "}
              {data.minCohortUsers} people match these filters, so the summary
              is hidden.
            </p>
          )}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-9">
            {data.tiles.map((t) => (
              <TileCard
                key={t.id}
                tile={t}
                active={t.id === activeMetric}
                onClick={() => onSelectMetric(t.id)}
                showDelta={!!compareLabel}
              />
            ))}
          </div>
        </>
      )}
    </WidgetFrame>
  );
}

function TileCard({
  tile,
  active,
  onClick,
  showDelta,
}: {
  tile: Tile;
  active: boolean;
  onClick: () => void;
  showDelta: boolean;
}) {
  const good =
    tile.delta === null || tile.higherIsBetter === null || tile.delta === 0
      ? null
      : tile.delta > 0 === tile.higherIsBetter;
  const arrow =
    tile.delta === null || tile.delta === 0 ? "" : tile.delta > 0 ? "▲" : "▼";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-md border px-3 py-2 text-left transition-colors hover:bg-plane ${active ? "border-series-1 ring-1 ring-series-1" : ""}`}
      style={active ? undefined : { borderColor: "var(--border)" }}
      data-metric={tile.id}
    >
      <p className="truncate text-xs text-ink-2">{tile.label}</p>
      <p className="mt-0.5 text-lg font-semibold text-ink">
        {tile.approximate && tile.value !== null && (
          <span className="text-ink-muted">≈</span>
        )}
        {formatValue(tile.value, tile.unit, { compact: true })}
      </p>
      {showDelta && !tile.notApplicable && (
        <p
          className="tabular text-xs"
          style={{
            color:
              good === null
                ? "var(--text-muted)"
                : good
                  ? "var(--delta-good)"
                  : "var(--delta-bad)",
          }}
        >
          {arrow} {formatDelta(tile.delta, tile.deltaKind)}
        </p>
      )}
      {tile.notApplicable && (
        <p
          className="mt-0.5 flex items-center gap-1 text-[11px] text-ink-muted"
          title={`Can't be split by ${tile.notApplicable}`}
        >
          <InfoIcon className="h-3 w-3" /> n/a with a {tile.notApplicable}{" "}
          filter
        </p>
      )}
      {tile.coverage && tile.coverage.state !== "ok" && (
        <p
          className="mt-0.5 flex items-center gap-1 text-[11px] text-ink-muted"
          title={tile.coverage.note}
        >
          <InfoIcon className="h-3 w-3" />
          {tile.coverage.state === "none"
            ? "not collected in range"
            : `since ${localTime(tile.coverage.from, "UTC", "MMM d")} UTC`}
        </p>
      )}
    </button>
  );
}
