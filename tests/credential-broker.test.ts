import { CredentialBroker, CredentialBrokerError } from '../src/security/credential-broker';

describe('CredentialBroker', () => {
  let broker: CredentialBroker;

  beforeEach(() => {
    broker = new CredentialBroker();
  });

  it('issues a credential and retrieves it within the same scope', () => {
    broker.issue({ toolId: 'github', action: 'read' }, 'ghp_test_token');
    const value = broker.retrieve({ toolId: 'github', action: 'read' }, 'tester');
    expect(value).toBe('ghp_test_token');
  });

  it('throws when the retrieval scope does not match the issue scope', () => {
    broker.issue({ toolId: 'github', action: 'read' }, 'ghp_test_token');
    expect(() => broker.retrieve({ toolId: 'github', action: 'write' }, 'tester')).toThrow(
      CredentialBrokerError,
    );
  });

  it('retrieve() throws NOT_FOUND for an unknown scope', () => {
    expect(() => broker.retrieve({ toolId: 'unknown' }, 'tester')).toThrow(CredentialBrokerError);
  });

  it('rotate() replaces the value while keeping the scope retrievable', () => {
    broker.issue({ toolId: 'stripe' }, 'sk_old');
    broker.rotate({ toolId: 'stripe' }, 'sk_new', 'admin');
    expect(broker.retrieve({ toolId: 'stripe' }, 'tester')).toBe('sk_new');
  });

  it('revoke() makes subsequent retrieve() calls fail', () => {
    broker.issue({ toolId: 'aws' }, 'AKIA_EXAMPLE');
    expect(broker.revoke({ toolId: 'aws' }, 'admin')).toBe(true);
    expect(() => broker.retrieve({ toolId: 'aws' }, 'tester')).toThrow(CredentialBrokerError);
  });

  it('revoke() returns false for a scope that was never issued', () => {
    expect(broker.revoke({ toolId: 'nonexistent' }, 'admin')).toBe(false);
  });

  it('listHandles() never exposes plaintext values', () => {
    broker.issue({ toolId: 'db' }, 'password123');
    const handles = broker.listHandles();
    expect(handles).toHaveLength(1);
    expect(JSON.stringify(handles)).not.toContain('password123');
  });
});
