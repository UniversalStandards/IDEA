import Link from 'next/link';

export default function HomePage(): React.JSX.Element {
  return (
    <main>
      <h1>IDEA — Universal MCP Orchestration Hub</h1>
      <nav>
        <ul>
          <li>
            <Link href="/auth/login">Login</Link>
          </li>
          <li>
            <Link href="/auth/register">Register</Link>
          </li>
          <li>
            <Link href="/admin">Admin Dashboard</Link>
          </li>
          <li>
            <Link href="/portal">User Portal</Link>
          </li>
        </ul>
      </nav>
    </main>
  );
}
