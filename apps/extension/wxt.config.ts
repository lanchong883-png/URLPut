import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifestVersion: 3,
  zip: { artifactTemplate: 'URLPut-WXT-{{version}}-{{browser}}.zip', zipSources: false },
  manifest: {
    name: 'URLPut',
    version: '0.1.0',
    description: '导入并管理外链候选',
    permissions: ['storage', 'sidePanel', 'offscreen'],
    host_permissions: ['http://127.0.0.1/*'],
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    action: { default_title: '打开 URLPut' },
  },
});
