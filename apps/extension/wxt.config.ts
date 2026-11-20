import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifestVersion: 3,
  manifest: {
    name: 'URLPut',
    version: '0.1.0',
    description: '导入并管理外链候选',
    permissions: ['storage', 'sidePanel'],
    host_permissions: ['http://127.0.0.1/*'],
    optional_host_permissions: ['https://*/*', 'http://localhost/*', 'http://[::1]/*'],
    action: { default_title: '打开 URLPut' },
  },
});
