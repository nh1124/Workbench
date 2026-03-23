import { readWorkbenchSession } from "../lib/api";
import { QuickNoteModal } from "../components/QuickNoteModal";

export function QuickNoteWindowPage() {
  const session = readWorkbenchSession();
  if (!session) {
    return (
      <div className="quick-note-window-shell">
        <section className="quick-note-modal" role="dialog" aria-modal="true" aria-label="Quick note sign in required">
          <header className="quick-note-head">
            <div>
              <h2>Quick Note</h2>
              <p>Sign in required</p>
            </div>
          </header>
          <div className="quick-note-body">
            <p className="quick-note-error">Please sign in from the main Workbench window first.</p>
          </div>
        </section>
      </div>
    );
  }

  const closeWindow = () => {
    window.close();
  };

  return <QuickNoteModal open onClose={closeWindow} standalone />;
}
