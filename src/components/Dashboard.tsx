import { KpiStrip } from "./KpiStrip";
import { CashPoorFeed, CustomSignalFeed, LienFeed, MaturityFeed, PermitFeed } from "./Feeds";
import { PipelineCard } from "./PipelineCard";

/**
 * Bento layout, high density:
 *   [ KPI ][ KPI ][ KPI ][ KPI ][ KPI ]
 *   [   Maturity Sniffer (4)  ][ Lien (2) ]
 *   [                         ][ Cash (2) ]
 *   [    Permits (4)          ][ Pipe (2) ]
 */
export function Dashboard() {
  return (
    <div className="flex flex-col gap-3">
      <KpiStrip />
      <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-6">
        <div className="flex flex-col gap-3 lg:col-span-4">
          <MaturityFeed />
          <PermitFeed />
        </div>
        <div className="flex flex-col gap-3 lg:col-span-2">
          <LienFeed />
          <CashPoorFeed />
          <CustomSignalFeed />
          <PipelineCard />
        </div>
      </div>
    </div>
  );
}
