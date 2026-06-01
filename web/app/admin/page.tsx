import Link from 'next/link';

export default function AdminDashboardPage(): React.JSX.Element {
  return (
    <main>
      <h1>Admin Dashboard</h1>
      <nav aria-label="Admin navigation">
        <ul>
          <li>
            <Link href="/admin/tools">Tools</Link>
          </li>
          <li>
            <Link href="/admin/workflows">Workflows</Link>
          </li>
          <li>
            <Link href="/admin/policies">Policies</Link>
          </li>
          <li>
            <Link href="/admin/users">Users &amp; API Keys</Link>
          </li>
        </ul>
      </nav>
    </main>
  );
}
