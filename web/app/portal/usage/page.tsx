export default function PortalUsagePage(): React.JSX.Element {
  return (
    <main>
      <h1>Usage Statistics</h1>
      <section aria-label="Usage summary">
        <h2>Summary</h2>
        <dl>
          <dt>Total requests</dt>
          <dd data-testid="total-requests">0</dd>
          <dt>Successful requests</dt>
          <dd data-testid="successful-requests">0</dd>
          <dt>Failed requests</dt>
          <dd data-testid="failed-requests">0</dd>
          <dt>Total cost (USD)</dt>
          <dd data-testid="total-cost">$0.00</dd>
        </dl>
      </section>
      <section aria-label="Usage by provider">
        <h2>Usage by provider</h2>
        <p>No usage data available yet.</p>
      </section>
    </main>
  );
}
