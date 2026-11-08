import { SheriffConfig } from '@softarc/sheriff-core';

/**
 * Architecture rules for the Angular app (DDD refactor step C7,
 * .agents/PLANS/ddd-refactor/ and decision D9).
 *
 * Target structure: `apps/cert-prep/src/app/<context>/<type>`, one module per
 * bounded context and layer, tagged `context:<context>` and `type:<type>`:
 * `feature` (pages and containers that inject stores), `ui` (presentational
 * components), `data` (stores and API calls), `domain` (types and pure
 * functions). Each module lists its public API in an `index.ts`; Sheriff's
 * encapsulation rule rejects imports of any other file from outside the
 * module. `core/shell` is the composition root (app component, routes, app
 * config, the guard, the workspace facade): it may import everything and
 * nothing imports it. `core/ui`, `core/data` and `core/domain` are the
 * app-wide shared code (icons, API client, interceptor, operation store,
 * generated API types) every context may use. Only create a layer that has
 * content. A folder name other than the four types (or `core/shell`) gets a
 * `type:` tag without a rule, which Sheriff reports (SH-002) once a file in it
 * imports another module.
 *
 * A dependency must satisfy both tags: its `type:` rule (layer direction) and
 * its `context:` rule (the context map in the plan's section 3: a context uses
 * only itself, its upstream contexts and `core`).
 *
 * The technical folders below the target entries are the code C7 has not yet
 * moved; they keep the C1 rules. Each moved folder's new `type:` tag is added
 * to the legacy rules that allowed the folder it came from (page and
 * component -> feature or ui, store and service -> data, contract and
 * constant -> domain), so legacy code keeps using it. A context or `core`
 * module never imports a not-yet-moved folder: move that code first instead
 * of adding a known exception
 * (`tools/quality/architecture-exceptions-baseline.json` may only shrink).
 */
const sharedLibraries = ['layer:shared-ui', 'layer:api-client'];
const contextRule = (...allowed: string[]): string[] => [
  ...allowed,
  'context:core',
  ...sharedLibraries,
];

export const config: SheriffConfig = {
  enableBarrelLess: true,
  modules: {
    'apps/cert-prep/src/app': {
      'core/shell': ['type:shell'],
      'core/<type>': ['context:core', 'type:<type>'],
      'projects/<type>': ['context:projects', 'type:<type>'],
      'source-library/<type>': ['context:source-library', 'type:<type>'],
      'capture/<type>': ['context:capture', 'type:<type>'],
      'authoring/<type>': ['context:authoring', 'type:<type>'],
      'practice/<type>': ['context:practice', 'type:<type>'],
      'runtime/<type>': ['context:runtime', 'type:<type>'],
      'pages/<page>': ['layer:page'],
      'components/<component>': ['layer:component'],
      stores: ['layer:store'],
      'stores/<store>': ['layer:store'],
      services: ['layer:service'],
      contracts: ['layer:contract'],
      testing: ['layer:testing'],
    },
    'libs/ui/<component>/src': ['layer:shared-ui'],
    'libs/cert-prep-api/src': ['layer:api-client'],
  },
  depRules: {
    root: ['layer:*', 'type:*', 'root'],

    // Target structure: layer direction.
    'type:shell': ['type:*', 'layer:*', 'root'],
    'type:feature': ['type:ui', 'type:data', 'type:domain', ...sharedLibraries],
    'type:ui': ['type:ui', 'type:domain', 'layer:shared-ui'],
    'type:data': ['type:data', 'type:domain', 'layer:api-client'],
    'type:domain': ['type:domain', 'layer:api-client'],

    // Target structure: context map (upstream contexts only). Runtime also
    // holds the AI provider surfaces (model health), which the plan's map
    // puts upstream of Source Library, Capture, Authoring and Practice.
    'context:core': ['context:core', ...sharedLibraries],
    'context:projects': contextRule('context:projects'),
    'context:runtime': contextRule('context:runtime'),
    'context:source-library': contextRule(
      'context:source-library',
      'context:projects',
      'context:runtime',
    ),
    'context:capture': contextRule(
      'context:capture',
      'context:source-library',
      'context:projects',
      'context:runtime',
    ),
    'context:authoring': contextRule(
      'context:authoring',
      'context:source-library',
      'context:projects',
      'context:runtime',
    ),
    'context:practice': contextRule(
      'context:practice',
      'context:authoring',
      'context:source-library',
      'context:projects',
      'context:runtime',
    ),

    // Technical folders not yet moved (C1 rules plus the moved code's tags).
    'layer:page': [
      'layer:page',
      'layer:component',
      'layer:shared-ui',
      'layer:store',
      'layer:service',
      'layer:contract',
      'layer:api-client',
      'type:feature',
      'type:ui',
      'type:data',
      'type:domain',
      'root',
    ],
    'layer:component': [
      'layer:component',
      'layer:shared-ui',
      'layer:store',
      'layer:service',
      'layer:contract',
      'layer:api-client',
      'type:feature',
      'type:ui',
      'type:data',
      'type:domain',
      'root',
    ],
    'layer:store': [
      'layer:store',
      'layer:service',
      'layer:contract',
      'layer:api-client',
      'type:data',
      'type:domain',
      'root',
    ],
    'layer:service': [
      'layer:service',
      'layer:contract',
      'layer:api-client',
      'type:data',
      'type:domain',
      'root',
    ],
    'layer:contract': ['layer:contract', 'layer:api-client', 'type:domain'],
    'layer:shared-ui': ['layer:shared-ui', 'noTag'],
    'layer:api-client': ['layer:api-client', 'noTag'],
    'layer:testing': ['layer:*', 'type:*', 'root'],
    noTag: ['noTag', 'root', 'layer:*', 'type:*'],
  },
};
