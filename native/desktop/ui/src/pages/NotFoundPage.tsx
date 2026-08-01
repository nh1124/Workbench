import { Link } from "react-router-dom";

export function NotFoundPage() {
  return (
    <section className="stack">
      <header className="page-header">
        <p className="eyebrow">404</p>
        <h2>Page not found</h2>
      </header>
      <article className="panel">
        <p>This page does not exist in the minimal Workspace UI scope.</p>
        <Link to="/">Go back Home</Link>
      </article>
    </section>
  );
}

