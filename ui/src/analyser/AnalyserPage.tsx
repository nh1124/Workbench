import { useSearchParams } from "react-router-dom";
import { ActivityTab } from "./components/ActivityTab";
import { OverviewTab } from "./components/OverviewTab";
import { ProposalTab } from "./components/ProposalTab";
import { RoutinesTab } from "./components/RoutinesTab";
import { SettingsTab } from "./components/SettingsTab";
import { SummaryTab } from "./components/SummaryTab";
import "./AnalyserPage.css";

const TABS = ["overview", "activity", "summaries", "proposals", "routines", "settings"] as const;

type AnalyserTab = (typeof TABS)[number];

export function AnalyserPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get("tab");
  const activeTab: AnalyserTab = TABS.includes(requestedTab as AnalyserTab)
    ? requestedTab as AnalyserTab
    : "overview";

  const selectTab = (tab: AnalyserTab) => {
    const next = new URLSearchParams(searchParams);
    if (tab === "overview") next.delete("tab");
    else next.set("tab", tab);
    setSearchParams(next);
  };

  return (
    <div className="analyser-page">
      <header className="analyser-header">
        <h1>Analyser</h1>
        <div className="analyser-tabs" role="tablist" aria-label="Analyser views">
          {TABS.map((tab) => (
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === tab}
              className={activeTab === tab ? "analyser-tab active" : "analyser-tab"}
              onClick={() => selectTab(tab)}
              key={tab}
            >
              {tab[0].toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>
      </header>

      {activeTab === "overview" ? <OverviewTab /> : null}
      {activeTab === "activity" ? <ActivityTab /> : null}
      {activeTab === "summaries" ? <SummaryTab /> : null}
      {activeTab === "proposals" ? <ProposalTab /> : null}
      {activeTab === "routines" ? <RoutinesTab /> : null}
      {activeTab === "settings" ? <SettingsTab /> : null}
    </div>
  );
}
