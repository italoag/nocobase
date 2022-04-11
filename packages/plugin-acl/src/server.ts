import { Plugin } from '@nocobase/server';
import { resolve } from 'path';
import { availableActionResource } from './actions/available-actions';
import { checkAction } from './actions/role-check';
import { roleCollectionsResource } from './actions/role-collections';
import { RoleModel } from './model/RoleModel';
import { RoleResourceActionModel } from './model/RoleResourceActionModel';
import { RoleResourceModel } from './model/RoleResourceModel';

export interface AssociationFieldAction {
  associationActions: string[];
  targetActions?: string[];
}

interface AssociationFieldActions {
  [availableActionName: string]: AssociationFieldAction;
}

export interface AssociationFieldsActions {
  [associationType: string]: AssociationFieldActions;
}

export class GrantHelper {
  resourceTargetActionMap = new Map<string, string[]>();
  targetActionResourceMap = new Map<string, string[]>();

  constructor() {}
}

export class PluginACL extends Plugin {
  associationFieldsActions: AssociationFieldsActions = {};

  grantHelper = new GrantHelper();

  get acl() {
    return this.app.acl;
  }

  registerAssociationFieldAction(associationType: string, value: AssociationFieldActions) {
    this.associationFieldsActions[associationType] = value;
  }

  registerAssociationFieldsActions() {
    this.registerAssociationFieldAction('linkTo', {
      view: {
        associationActions: ['list', 'get'],
      },
      create: {
        associationActions: ['add'],
        targetActions: ['view'],
      },
      update: {
        associationActions: ['add', 'remove', 'toggle'],
        targetActions: ['view'],
      },
    });

    this.registerAssociationFieldAction('attachments', {
      view: {
        associationActions: ['list', 'get'],
      },
      add: {
        associationActions: ['upload', 'add'],
      },
      update: {
        associationActions: ['update', 'add', 'remove', 'toggle'],
      },
    });

    this.registerAssociationFieldAction('subTable', {
      view: {
        associationActions: ['list', 'get'],
      },
      create: {
        associationActions: ['create'],
      },
      update: {
        associationActions: ['update', 'destroy'],
      },
    });
  }

  async writeResourceToACL(resourceModel: RoleResourceModel, transaction) {
    await resourceModel.writeToACL({
      acl: this.acl,
      associationFieldsActions: this.associationFieldsActions,
      transaction: transaction,
      grantHelper: this.grantHelper,
    });
  }

  async writeActionToACL(actionModel: RoleResourceActionModel, transaction) {
    const resource = actionModel.get('resource') as RoleResourceModel;
    const role = this.acl.getRole(resource.get('roleName') as string);
    await actionModel.writeToACL({
      acl: this.acl,
      role,
      resourceName: resource.get('name') as string,
      associationFieldsActions: this.associationFieldsActions,
      grantHelper: this.grantHelper,
    });
  }

  async writeRolesToACL() {
    const roles = (await this.app.db.getRepository('roles').find({
      appends: ['resources', 'resources.actions'],
    })) as RoleModel[];
    for (const role of roles) {
      role.writeToAcl({ acl: this.acl });
      for (const resource of role.get('resources') as RoleResourceModel[]) {
        await this.writeResourceToACL(resource, null);
      }
    }
  }

  async beforeLoad() {
    this.app.db.registerModels({
      RoleResourceActionModel,
      RoleResourceModel,
      RoleModel,
    });

    this.registerAssociationFieldsActions();

    this.app.resourcer.define(availableActionResource);
    this.app.resourcer.define(roleCollectionsResource);

    this.app.resourcer.registerActionHandler('roles:check', checkAction);

    this.app.db.on('roles.afterSaveWithAssociations', async (model, options) => {
      const { transaction } = options;

      model.writeToAcl({
        acl: this.acl,
      });

      for (const resource of (await model.getResources({ transaction })) as RoleResourceModel[]) {
        await this.writeResourceToACL(resource, transaction);
      }

      // model is default
      if (model.get('default')) {
        await this.app.db.getRepository('roles').update({
          values: {
            default: false,
          },
          filter: {
            'name.$ne': model.get('name'),
          },
          hooks: false,
          transaction,
        });
      }
    });

    this.app.db.on('roles.afterDestroy', (model) => {
      const roleName = model.get('name');
      this.acl.removeRole(roleName);
    });

    this.app.db.on('rolesResources.afterSaveWithAssociations', async (model: RoleResourceModel, options) => {
      await this.writeResourceToACL(model, options.transaction);
    });

    this.app.db.on('rolesResourcesActions.afterUpdateWithAssociations', async (model, options) => {
      const { transaction } = options;
      const resource = await model.getResource({
        transaction,
      });

      await this.writeResourceToACL(resource, transaction);
    });

    this.app.db.on('rolesResources.afterDestroy', async (model, options) => {
      const role = this.acl.getRole(model.get('roleName'));
      role.revokeResource(model.get('name'));
    });

    this.app.db.on('collections.afterDestroy', async (model, options) => {
      const { transaction } = options;
      await this.app.db.getRepository('rolesResources').destroy({
        filter: {
          name: model.get('name'),
        },
        transaction,
      });
    });

    this.app.db.on('fields.afterCreate', async (model, options) => {
      const { transaction } = options;

      const collectionName = model.get('collectionName');
      const fieldName = model.get('name');

      const resourceActions = (await this.app.db.getRepository('rolesResourcesActions').find({
        filter: {
          'resource.name': collectionName,
        },
        transaction,
        appends: ['resource'],
      })) as RoleResourceActionModel[];

      for (const resourceAction of resourceActions) {
        const fields = resourceAction.get('fields') as string[];
        const newFields = [...fields, fieldName];

        await this.app.db.getRepository('rolesResourcesActions').update({
          filterByTk: resourceAction.get('id') as number,
          values: {
            fields: newFields,
          },
          transaction,
        });
      }
    });

    this.app.db.on('fields.afterDestroy', async (model, options) => {
      const collectionName = model.get('collectionName');
      const fieldName = model.get('name');

      const resourceActions = await this.app.db.getRepository('rolesResourcesActions').find({
        filter: {
          'resource.name': collectionName,
          'fields.$anyOf': [fieldName],
        },
        transaction: options.transaction,
      });

      for (const resourceAction of resourceActions) {
        const fields = resourceAction.get('fields') as string[];
        const newFields = fields.filter((field) => field != fieldName);

        await this.app.db.getRepository('rolesResourcesActions').update({
          filterByTk: resourceAction.get('id') as number,
          values: {
            fields: newFields,
          },
          transaction: options.transaction,
        });
      }
    });

    // sync database role data to acl
    this.app.on('beforeStart', async () => {
      await this.writeRolesToACL();
    });

    this.app.on('beforeInstallPlugin', async (plugin) => {
      if (plugin.constructor.name !== 'UsersPlugin') {
        return;
      }
      const roles = this.app.db.getRepository('roles');
      await roles.createMany({
        records: [
          {
            name: 'root',
            title: 'Root',
            hidden: true,
          },
          {
            name: 'admin',
            title: 'Admin',
          },
          {
            name: 'member',
            title: 'Member',
            default: true,
          },
          {
            name: 'anonymous',
            title: 'Anonymous',
          },
        ],
      });
      const rolesResourcesScopes = this.app.db.getRepository('rolesResourcesScopes');
      await rolesResourcesScopes.createMany({
        records: [
          {
            name: '{{t("All records")}}',
            scope: {},
          },
          {
            name: '{{t("Own records")}}',
            scope: {
              createdById: '{{ ctx.state.currentUser.id }}',
            },
          },
        ],
      });
    });
    this.app.acl.skip('roles.menuUiSchemas', 'set', 'logged-in');
    this.app.acl.skip('roles.menuUiSchemas', 'toggle', 'logged-in');
    this.app.acl.skip('roles.menuUiSchemas', 'list', 'logged-in');
    this.app.acl.skip('roles', 'check', 'logged-in');
    this.app.acl.skip('*', '*', (ctx) => {
      return ctx.state.currentRole === 'root';
    });

    // root role 
    this.app.resourcer.use(async (ctx, next) => {
      const { actionName, resourceName } = ctx.action.params;
      if (actionName === 'list' && resourceName === 'roles') {
        ctx.action.mergeParams({
          filter: {
            'name.$ne': 'root',
          },
        });
      }
      await next();
    });
  }

  async install() {
    const repo = this.db.getRepository<any>('collections');
    if (repo) {
      await repo.db2cm('roles');
    }
  }

  async load() {
    await this.app.db.import({
      directory: resolve(__dirname, 'collections'),
    });

    this.app.resourcer.use(this.acl.middleware());
  }

  getName(): string {
    return this.getPackageName(__dirname);
  }
}

export default PluginACL;
