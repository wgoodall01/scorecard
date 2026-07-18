import type { HandicapPoint, PlayerHandicap } from "api";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Badge } from "@/components/ui/badge";
import { formatOutingDate } from "@/pages/outings";

// Golf convention: a negative index is a "plus" handicap.
function formatIndex(index: number) {
  return index < 0 ? `+${Math.abs(index).toFixed(1)}` : index.toFixed(1);
}

function shortDate(date: string) {
  // Anchor the naive date to noon so it never slides across midnight.
  return new Date(`${date}T12:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

const chartConfig = {
  index: { label: "Casual Handicap", color: "var(--chart-3)" },
} satisfies ChartConfig;

export function HandicapCard({ handicap }: { handicap: PlayerHandicap | null }) {
  return (
    <section className="rounded-xl border bg-card">
      <div className="flex items-center gap-2 border-b p-5">
        <h2 className="font-medium">Casual Handicap</h2>
        {handicap?.provisional && handicap.index !== null && (
          <Badge variant="secondary">Provisional</Badge>
        )}
      </div>
      <div className="flex flex-col gap-4 p-5">
        {!handicap && <p className="text-sm text-muted-foreground">Loading casual handicap…</p>}
        {handicap && handicap.index === null && (
          <p className="text-sm text-muted-foreground">
            No rated rounds recorded yet — a casual handicap appears after the first captured round
            on a rated nine.
          </p>
        )}
        {handicap && handicap.index !== null && (
          <>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <p className="text-4xl font-semibold tracking-tight">{formatIndex(handicap.index)}</p>
              {handicap.asOf && (
                <p className="text-sm text-muted-foreground">
                  as of {formatOutingDate(handicap.asOf)} · {handicap.differentialCount}{" "}
                  {handicap.differentialCount === 1 ? "score" : "scores"}
                </p>
              )}
            </div>
            {handicap.provisional && (
              <p className="text-sm text-muted-foreground">
                There aren't enough scores for a traditional handicap yet, so this is a provisional
                one — it becomes official at three posted scores.
              </p>
            )}
            {handicap.timeseries.length >= 2 && (
              <ChartContainer config={chartConfig} className="aspect-[2/1] w-full">
                <LineChart
                  accessibilityLayer
                  data={handicap.timeseries}
                  margin={{ left: 0, right: 12, top: 8, bottom: 0 }}
                >
                  <CartesianGrid vertical={false} />
                  <XAxis
                    dataKey="date"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    minTickGap={32}
                    tickFormatter={shortDate}
                  />
                  <YAxis
                    width={36}
                    tickLine={false}
                    axisLine={false}
                    tickCount={4}
                    domain={["auto", "auto"]}
                    tickFormatter={(value: number) => formatIndex(value)}
                  />
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        hideIndicator
                        labelFormatter={(_, payload) => {
                          const point = payload?.[0]?.payload as HandicapPoint | undefined;
                          return point ? formatOutingDate(point.date) : null;
                        }}
                        formatter={(value, _name, _item, _index, payload) => {
                          const point = payload as unknown as HandicapPoint;
                          return (
                            <div className="flex w-full flex-col gap-1">
                              <div className="flex items-center justify-between gap-4 leading-none">
                                <span className="text-muted-foreground">
                                  Casual Handicap{point.provisional ? " (provisional)" : ""}
                                </span>
                                <span className="font-medium tabular-nums">
                                  {formatIndex(Number(value))}
                                </span>
                              </div>
                              <div className="flex items-center justify-between gap-4 leading-none">
                                <span className="text-muted-foreground">
                                  {point.holes}-hole differential
                                </span>
                                <span className="font-medium tabular-nums">
                                  {point.differential.toFixed(1)}
                                </span>
                              </div>
                            </div>
                          );
                        }}
                      />
                    }
                  />
                  <Line
                    dataKey="index"
                    type="linear"
                    stroke="var(--color-index)"
                    strokeWidth={2}
                    isAnimationActive={false}
                    dot={{
                      r: 3.5,
                      strokeWidth: 2,
                      stroke: "var(--card)",
                      fill: "var(--color-index)",
                    }}
                    activeDot={{ r: 4.5 }}
                  />
                </LineChart>
              </ChartContainer>
            )}
          </>
        )}
      </div>
    </section>
  );
}
