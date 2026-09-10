export default function PrayerPanel({ online }) {
  return (
    <details className="prayer-panel">
      <summary>
        <span>Prayer times</span>
        <span className="prayer-caption">Optional · Awqaf UAE</span>
      </summary>
      <div className="prayer-content">
        <p>
          Prayer reminders are unavailable: Awqaf’s service doesn’t accept this
          local app’s connection. You can still check its official UAE prayer times.
        </p>
        {online ? (
          <a
            className="prayer-source-link"
            href="https://www.awqaf.ae/prayer-times"
            target="_blank"
            rel="noopener noreferrer"
          >
            Open Awqaf prayer times <span aria-hidden="true">↗</span>
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        ) : (
          <p className="prayer-offline" role="status">
            Connect to the internet to open Awqaf prayer times.
          </p>
        )}
      </div>
    </details>
  );
}
