import { SheriffConfig } from '@softarc/sheriff-core';

/**
 * Architecture rules for the Angular app (DDD refactor step C1,
 * .agents/PLANS/ddd-refactor/). They describe today's technical folders so that
 * no new import points back up the chain page → component → store → service →
 * contract. Step C6 replaces them with one module per bounded context.
 */
export const config: SheriffConfig = {
  enableBarrelLess: true,
  modules: {
    'apps/cert-prep/src/app': {
      'pages/<page>': ['layer:page'],
      'components/ui': ['layer:ui'],
      'components/<component>': ['layer:component'],
      stores: ['layer:store'],
      'stores/<store>': ['layer:store'],
      services: ['layer:service'],
      contracts: ['layer:contract'],
      constants: ['layer:constant'],
      guards: ['layer:routing'],
      interceptors: ['layer:routing'],
      testing: ['layer:testing'],
    },
    'libs/ui/<component>/src': ['layer:shared-ui'],
    'libs/cert-prep-api/src': ['layer:api-client'],
  },
  depRules: {
    root: ['layer:*', 'root'],
    'layer:page': [
      'layer:page',
      'layer:component',
      'layer:ui',
      'layer:shared-ui',
      'layer:store',
      'layer:service',
      'layer:contract',
      'layer:constant',
      'layer:api-client',
      'root',
    ],
    'layer:component': [
      'layer:component',
      'layer:ui',
      'layer:shared-ui',
      'layer:store',
      'layer:service',
      'layer:contract',
      'layer:constant',
      'layer:api-client',
      'root',
    ],
    'layer:ui': [
      'layer:ui',
      'layer:shared-ui',
      'layer:contract',
      'layer:constant',
    ],
    'layer:store': [
      'layer:store',
      'layer:service',
      'layer:contract',
      'layer:constant',
      'layer:api-client',
      'root',
    ],
    'layer:service': [
      'layer:service',
      'layer:contract',
      'layer:constant',
      'layer:api-client',
      'root',
    ],
    'layer:routing': [
      'layer:store',
      'layer:service',
      'layer:contract',
      'layer:constant',
      'root',
    ],
    'layer:contract': ['layer:contract', 'layer:api-client'],
    'layer:constant': ['layer:constant', 'layer:contract', 'layer:api-client'],
    'layer:shared-ui': ['layer:shared-ui', 'noTag'],
    'layer:api-client': ['layer:api-client', 'noTag'],
    'layer:testing': ['layer:*', 'root'],
    noTag: ['noTag', 'root', 'layer:*'],
  },
};
