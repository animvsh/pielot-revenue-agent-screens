import './App.css'

function App() {
  return (
    <main className="page">
      <header className="brand">
        <div className="brand-mark" aria-hidden="true">
          <span className="blob b1"></span>
          <span className="blob b2"></span>
          <span className="blob b3"></span>
          <span className="blob b4"></span>
        </div>
        <span className="brand-text">Lovable</span>
      </header>

      <section className="card">
        <h1>Internal Lovable project</h1>
        <p>This Lovable project is only available to authorized workspace members.</p>
        <div className="actions">
          <button type="button" className="btn primary">
            Continue with Google
          </button>
          <button type="button" className="btn secondary">
            Continue with GitHub
          </button>
          <button type="button" className="btn secondary">
            Continue with Email
          </button>
        </div>
        <div className="foot">
          <a href="https://lovable.dev/auth-bridge">Open auth bridge</a>
          <a href="https://lovable.dev">Lovable</a>
        </div>
      </section>

      <section className="not-found">
        <div className="code">404</div>
        <h2>Page not found</h2>
        <p>The page you&apos;re looking for doesn&apos;t exist or has been moved.</p>
        <button type="button" className="btn ghost">
          Go home
        </button>
      </section>
    </main>
  )
}

export default App
