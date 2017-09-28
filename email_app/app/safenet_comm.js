import { shell } from 'electron';
import { CONSTANTS, MESSAGES, SAFE_APP_ERROR_CODES } from './constants';
import { initializeApp, fromAuthURI } from '@maidsafe/safe-node-app';
import { getAuthData, saveAuthData, clearAuthData, genRandomEntryKey,
         splitPublicIdAndService, deserialiseArray, parseUrl } from './utils/app_utils';
import pkg from '../package.json';

const APP_INFO = {
  info: {
    id: pkg.identifier,
    scope: null,
    name: pkg.productName,
    vendor: pkg.vendor
  },
  opts: {
    own_container: true
  },
  containers: {
    publicNames: '_publicNames'
  },
  permissions: {
    _publicNames: ['Read', 'Insert']
  }
};

const genServiceInfo = async (app, emailId) => {
  let serviceInfo = splitPublicIdAndService(emailId);
  const hashed = await app.crypto.sha3Hash(serviceInfo.publicId);
  serviceInfo.serviceAddr = hashed;
  return serviceInfo;
}

const requestShareMdAuth = async (app, mdPermissions) => {
  const resp = await app.auth.genShareMDataUri(mdPermissions);
  shell.openExternal(parseUrl(resp.uri));
  return null;
}

const requestAuth = async () => {
  const app = await initializeApp(APP_INFO.info);
  const resp = app.auth.genAuthUri(APP_INFO.permissions, APP_INFO.opts);
  shell.openExternal(parseUrl(resp.uri));
  return null;
}

export const authApp = async (netStatusCallback) => {
  if (process.env.SAFE_FAKE_AUTH) {
    const app = await initializeApp(APP_INFO.info);
    return app.auth.loginForTest(APP_INFO.permissions);
  }

  const uri = getAuthData();
  if (uri) {
    try {
      const registeredApp = await fromAuthURI(APP_INFO.info, uri, netStatusCallback);
      await registeredApp.auth.refreshContainersPermissions();
      return registeredApp;
    } catch (err) {
      console.warn("Auth URI stored is not valid anymore, app needs to be re-authorised.");
      clearAuthData();
      return requestAuth();
    }
  }
  return requestAuth();
}

export const connect = async (uri, netStatusCallback) => {
  const registeredApp = await fromAuthURI(APP_INFO.info, uri, netStatusCallback);
  // synchronous
  saveAuthData(uri);
  await registeredApp.auth.refreshContainersPermissions();
  return registeredApp;
}

export const reconnect = (app) => {
  return app.reconnect();
}

const fetchPublicIds = async (app) => {
  let rawEntries = [];
  let publicIds = [];
  const pubNamesMd = await app.auth.getContainer(APP_INFO.containers.publicNames);
  const entries = await pubNamesMd.getEntries();
  await entries.forEach((key, value) => {
    rawEntries.push({key, value});
  });

  await Promise.all(rawEntries.map( async (entry) => {
    if (entry.value.buf.length === 0) { //FIXME: this condition is a work around for a limitation in safe_core
      return Promise.resolve();
    }

    const decKey = await pubNamesMd.decrypt(entry.key);
    const id = decKey.toString();
    if (id === CONSTANTS.MD_META_KEY) { // Skip the metadata entry
      return Promise.resolve();
    }
    const service = await pubNamesMd.decrypt(entry.value.buf);
    publicIds.push({ id, service });
  }));

  return publicIds;
}

export const fetchEmailIds = async (app) => {
  let emailIds = [];

  const publicIds = await fetchPublicIds(app);
  await Promise.all(publicIds.map( async (publicId) => {
      let rawEmailIds = [];
      const servicesMd = await app.mutableData.newPublic(publicId.service, CONSTANTS.TAG_TYPE_DNS);
      const keys = await servicesMd.getKeys();
      await keys.forEach((key) => {
        rawEmailIds.push(key.toString());
      });
      await Promise.all(rawEmailIds.map((emailId) => {
        // Let's filter out the services which are not email services,
        // i.e. those which don't have the `@email` postfix.
        // This will filter out the MD metadata entry also.
        const regex = new RegExp('.*(?=' + CONSTANTS.SERVICE_NAME_POSTFIX +'$)', 'g');
        let res = regex.exec(emailId);
        if (res) {
          emailIds.push(res[0] + ((res[0].length > 0) ? '.' : '') + publicId.id);
        }
      }))
  }));
  return emailIds;
}

export const readConfig = async (app, emailId) => {
  let account = {id: emailId};

  const md = await app.auth.getOwnContainer();
  const value = await md.encryptKey(emailId).then((key) => md.get(key));
  const decrypted = await md.decrypt(value.buf);
  const storedAccount = JSON.parse(decrypted);
  const inboxMd = await app.mutableData.fromSerial(storedAccount[CONSTANTS.ACCOUNT_KEY_EMAIL_INBOX]);
  account.inboxMd = inboxMd;
  const archiveMd = await app.mutableData.fromSerial(storedAccount[CONSTANTS.ACCOUNT_KEY_EMAIL_ARCHIVE]);
  account.archiveMd = archiveMd;
  account.encSk = storedAccount[CONSTANTS.ACCOUNT_KEY_EMAIL_ENC_SECRET_KEY];
  account.encPk = storedAccount[CONSTANTS.ACCOUNT_KEY_EMAIL_ENC_PUBLIC_KEY]
  return account;
}

const insertEncrypted = async (md, mut, key, value) => {
  const encryptedKey = await md.encryptKey(key);
  const encryptedValue = await md.encryptValue(value);
  return mut.insert(encryptedKey, encryptedValue);
}

export const writeConfig = async (app, account) => {
  let emailAccount = {
    [CONSTANTS.ACCOUNT_KEY_EMAIL_ID]: account.id,
    [CONSTANTS.ACCOUNT_KEY_EMAIL_ENC_SECRET_KEY]: account.encSk,
    [CONSTANTS.ACCOUNT_KEY_EMAIL_ENC_PUBLIC_KEY]: account.encPk
  };

  const serialisedInbox = await account.inboxMd.serialise();
  emailAccount[CONSTANTS.ACCOUNT_KEY_EMAIL_INBOX] = serialisedInbox;
  const serialisedArchive = await account.archiveMd.serialise();
  emailAccount[CONSTANTS.ACCOUNT_KEY_EMAIL_ARCHIVE] = serialisedArchive;
  const md = await app.auth.getOwnContainer();
  const mut = await app.mutableData.newMutation();
  await insertEncrypted(md, mut, account.id, JSON.stringify(emailAccount));
  await md.applyEntriesMutation(mut);
  return account;
}

const decryptEmail = async (app, account, key, value, cb) => {
  if (value.length > 0) { //FIXME: this condition is a work around for a limitation in safe_core
    const entryValue = await decrypt(app, value, account.encSk, account.encPk);
    const immData = await app.immutableData.fetch(deserialiseArray(entryValue));
    const content = await immData.read();
    const decryptedEmail = await decrypt(app, content, account.encSk, account.encPk);
    return cb({ id: key, email: JSON.parse(decryptedEmail) });
  }
}

export const readInboxEmails = async (app, account, cb) => {
  const entries = await account.inboxMd.getEntries();
  await entries.forEach((key, value) => {
    if (key.toString() !== CONSTANTS.MD_KEY_EMAIL_ENC_PUBLIC_KEY) {
      return decryptEmail(app, account, key, value.buf, cb);
    }
  });
  return entries.len();
}

export const readArchivedEmails = async (app, account, cb) => {
  const entries = await account.archiveMd.getEntries();
  await entries.forEach((key, value) => {
    return decryptEmail(app, account, key, value.buf, cb);
  })
}

const createInbox = async (app, encPk) => {
  let baseInbox = {
    [CONSTANTS.MD_KEY_EMAIL_ENC_PUBLIC_KEY]: encPk
  };

  const inboxMd = await app.mutableData.newRandomPublic(CONSTANTS.TAG_TYPE_INBOX)
  await inboxMd.quickSetup(baseInbox);
  const permSet = await app.mutableData.newPermissionSet();
  await permSet.setAllow('Insert');
  await inboxMd.setUserPermissions(null, permSet, 1);
  return inboxMd;
}

const createArchive = async (app) => {
  const md = await app.mutableData.newRandomPrivate(CONSTANTS.TAG_TYPE_EMAIL_ARCHIVE);
  return md.quickSetup();
}

const createPublicIdAndEmailService = async (
  app, pubNamesMd, serviceInfo, inboxSerialised
) => {
  const metadata = {
    ...CONSTANTS.SERVICE_METADATA,
    name: `${CONSTANTS.SERVICE_METADATA.name}: '${serviceInfo.publicId}'`,
    description: `${CONSTANTS.SERVICE_METADATA.description}: '${serviceInfo.publicId}'`
  };

  const md = await app.mutableData.newPublic(serviceInfo.serviceAddr, CONSTANTS.TAG_TYPE_DNS)
  await md.quickSetup(
    { [serviceInfo.serviceName]: inboxSerialised }, metadata.name, metadata.description
  );
  const mut = await app.mutableData.newMutation();
  await insertEncrypted(pubNamesMd, mut, serviceInfo.publicId, serviceInfo.serviceAddr);
  return pubNamesMd.applyEntriesMutation(mut);
}

const genNewAccount = async (app, id) => {
  const keyPair = await genKeyPair(app);
  const inboxMd = await createInbox(app, keyPair.publicKey);
  const archiveMd = await createArchive(app);
  return {id, inboxMd, archiveMd,
                        encSk: keyPair.privateKey,
                        encPk: keyPair.publicKey};
}

const registerEmailService = async (app, serviceToRegister) => {
  const newAccount = await genNewAccount(app, serviceToRegister.emailId);
  const inboxSerialised = await newAccount.inboxMd.serialise();
  const md = await app.mutableData.newPublic(serviceToRegister.servicesXorName, CONSTANTS.TAG_TYPE_DNS);
  const mut = await app.mutableData.newMutation();
  await mut.insert(serviceToRegister.serviceName, inboxSerialised);
  await md.applyEntriesMutation(mut);
  return newAccount;
}

export const createEmailService = async (app, servicesXorName, serviceInfo) => {
  const emailService = {
    servicesXorName,
    emailId: serviceInfo.emailId,
    serviceName: serviceInfo.serviceName
  };

  const appSignKey = await app.crypto.getAppPubSignKey();
  const md = await app.mutableData.newPublic(servicesXorName, CONSTANTS.TAG_TYPE_DNS);
  // QUESTION: What is the purpose of this line?
  await md.getUserPermissions(appSignKey) // FIXME: the permissions it has could not be enough
  try {
    const newAccount = await registerEmailService(app, emailService);
    return { newAccount };
  } catch (err) {
    await requestShareMdAuth(
      app,
      [{ type_tag: CONSTANTS.TAG_TYPE_DNS, name: servicesXorName, perms: ['Insert'] }]
    );
    return emailService;
  }
}

export const setupAccount = (app, emailId) => {
  let serviceInfo;
  return genServiceInfo(app, emailId)
    .then((info) => serviceInfo = info)
    .then(() => app.auth.getContainer(APP_INFO.containers.publicNames))
    .then((pubNamesMd) => pubNamesMd.encryptKey(serviceInfo.publicId).then((key) => pubNamesMd.get(key))
      // If service container already exists, try to add email service
      .then((encryptedAddr) => pubNamesMd.decrypt(encryptedAddr.buf)
        .then((servicesXorName) => createEmailService(app, servicesXorName, serviceInfo))
      , (err) => { // ...if not then create it
        if (err.code !== SAFE_APP_ERROR_CODES.ERR_NO_SUCH_ENTRY) {
          throw err;
        }
        // The public ID doesn't exist in _publicNames
        return genNewAccount(app, serviceInfo.emailId)
          .then((newAccount) => newAccount.inboxMd.serialise()
            .then((inboxSerialised) => createPublicIdAndEmailService(app,
                                pubNamesMd, serviceInfo, inboxSerialised))
            .then(() => ({ newAccount }))
          )
      })
    );
}

export const connectWithSharedMd = async (app, uri, serviceToRegister) => {
  await app.auth.loginFromURI(uri);
  await app.auth.refreshContainersPermissions();
  return registerEmailService(app, serviceToRegister);
}

const writeEmailContent = async (app, email, pk) => {
  const encryptedEmail = await encrypt(app, JSON.stringify(email), pk);
  const emailWriter = await app.immutableData.create();
  await emailWriter.write(encryptedEmail);
  const cipherOpt = await app.cipherOpt.newPlainText();
  return emailWriter.close(cipherOpt);
}

export const storeEmail = async (app, email, to) => {
  const serviceInfo = await genServiceInfo(app, to);
  const md = await app.mutableData.newPublic(serviceInfo.serviceAddr, CONSTANTS.TAG_TYPE_DNS);
  const service = await md.get(serviceInfo.serviceName);
  if(!service) { throw MESSAGES.EMAIL_ID_NOT_FOUND }
  const inboxMd = await app.mutableData.fromSerial(service.buf);
  const pk = await inboxMd.get(CONSTANTS.MD_KEY_EMAIL_ENC_PUBLIC_KEY);
  const emailAddr = await writeEmailContent(app, email, pk.buf.toString());
  const mut = await app.mutableData.newMutation();
  const entryKey = genRandomEntryKey();
  const entryValue = await encrypt(app, emailAddr, pk.buf.toString());
  await mut.insert(entryKey, entryValue);
  return inboxMd.applyEntriesMutation(mut);
}

export const removeEmail = async (app, container, key) => {
  const mut = await app.mutableData.newMutation();
  await mut.remove(key, 1);
  return container.applyEntriesMutation(mut);
}

export const archiveEmail = async (app, account, key) => {
  let newEntryKey = genRandomEntryKey();
  const xorName = await account.inboxMd.get(key);
  let mut = await app.mutableData.newMutation();
  await mut.insert(newEntryKey, xorName.buf);
  await account.archiveMd.applyEntriesMutation(mut);
  mut = await app.mutableData.newMutation();
  await mut.remove(key, 1);
  return account.inboxMd.applyEntriesMutation(mut);
}

const genKeyPair = async (app) => {
  let rawKeyPair = {};
  const keyPair = await app.crypto.generateEncKeyPair();
  const rawPubEncKey = await keyPair.pubEncKey.getRaw();
  rawKeyPair.publicKey = rawPubEncKey.buffer.toString('hex');
  const rawSecEncKey = await keyPair.secEncKey.getRaw();
  rawKeyPair.privateKey = rawSecEncKey.buffer.toString('hex');
  return rawKeyPair;
}

const encrypt = async (app, input, pk) => {
  if(Array.isArray(input)) {
    input = input.toString();
  }
  const stringToBuffer = Buffer.from(pk, 'hex');
  const pubEncKeyAPI = await app.crypto.pubEncKeyKeyFromRaw(stringToBuffer);
  return pubEncKeyAPI.encryptSealed(input);
};

const decrypt = async (app, cipherMsg, sk, pk) => {
  const keyPair = await app.crypto.generateEncKeyPairFromRaw(Buffer.from(pk, 'hex'), Buffer.from(sk, 'hex'));
  const decrypted = await keyPair.decryptSealed(cipherMsg);
  return decrypted.toString();
};
