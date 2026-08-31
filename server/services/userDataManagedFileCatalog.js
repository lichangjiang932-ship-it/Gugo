import {
  appDataRoot,
  artifactRoot,
  storageToken,
} from './userDataManagedFileCatalogSupport.js'

export {
  buildManagedUserFileCatalog,
  openManagedFileDescriptor,
} from './userDataManagedFileCatalogBuilder.js'

export {
  cleanupManagedDeletionStage,
  rollbackManagedDeletionStage,
  stageManagedDeletionDomain,
} from './userDataManagedDeletionStage.js'

export const _testing = {
  appDataRoot,
  artifactRoot,
  storageToken,
}
