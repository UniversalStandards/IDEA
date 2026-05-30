import { HubClient } from '../src';

describe('Capability, Workflow, and Admin clients', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('calls typed endpoints for capability/workflow/admin operations', async () => {
    const fetchMock = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockImplementation(async () =>
        new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } }),
      );

    const hub = new HubClient({
      baseUrl: 'https://hub.example.com',
      apiKey: 'api-key-1',
      fetchImpl: fetchMock,
    });

    await hub.capabilities.search('filesystem');
    await hub.capabilities.install('cap-1');
    await hub.capabilities.list('org-1');
    await hub.capabilities.invoke('cap-1', { input: true });

    await hub.workflows.run('wf-1', { file: '/tmp/a.txt' });
    await hub.workflows.list({ status: 'running', tenantId: 'tenant-1' });
    await hub.workflows.cancel('run-1');
    await hub.workflows.getStatus('run-1');

    await hub.admin.listTenants();
    await hub.admin.getTenant('tenant-1');
    await hub.admin.createTenant({ name: 'Tenant One' });
    await hub.admin.updateTenant('tenant-1', { metadata: { tier: 'gold' } });
    await hub.admin.deleteTenant('tenant-1');
    await hub.admin.getQuota('tenant-1');
    await hub.admin.setQuota('tenant-1', { maxRunsPerHour: 10, maxCapabilities: 5 });
    await hub.admin.health();

    const calledUrls = fetchMock.mock.calls.map(([url]) => String(url));

    expect(calledUrls).toContain('https://hub.example.com/capabilities/search?query=filesystem');
    expect(calledUrls).toContain('https://hub.example.com/workflows/run');
    expect(calledUrls).toContain('https://hub.example.com/admin/tenants/tenant-1/quota');

    const workflowRunCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/workflows/run'));
    expect(workflowRunCall?.[1]?.method).toBe('POST');

    hub.close();
  });
});
