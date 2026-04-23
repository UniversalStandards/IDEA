import Link from 'next/link';

export default function PortalPage(): React.JSX.Element {
  return (
    <main>
      <h1>User Portal</h1>
      <nav aria-label="Portal navigation">
        <ul>
          <li>
            <Link href="/portal/api-keys">API Keys</Link>
          </li>
          <li>
            <Link href="/portal/usage">Usage Statistics</Link>
          </li>
          <li>
            <Link href="/portal/settings">Profile Settings</Link>
          </li>
        </ul>
      </nav>
    </main>
  );
}
