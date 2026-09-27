// electron-builder v26 configuration. Public builds require the signed release gate.
const signed = process.env.WORKROOM_SIGNED_RELEASE === '1';
module.exports = {
  appId: 'app.workroom.desktop',
  productName: 'Workroom',
  directories: { output: signed ? 'release-public' : (process.env.WORKROOM_OUTPUT_DIR || 'release-candidate') },
  artifactName: 'Workroom-${version}-${arch}' + (signed ? '' : '-preview') + '.${ext}',
  asar: true,
  npmRebuild: false,
  compression: 'normal',
  files: ['out/**/*', 'package.json', 'LICENSE', 'PRIVACY.md', 'SECURITY.md'],
  forceCodeSigning: signed,
  electronFuses: {
    runAsNode: true,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: !signed,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    grantFileProtocolExtraPrivileges: false
  },
  mac: {
    category: 'public.app-category.developer-tools',
    target: [{ target: 'dmg', arch: ['arm64'] }, { target: 'zip', arch: ['arm64'] }],
    icon: 'build/icon.icns',
    identity: signed ? undefined : '-',
    hardenedRuntime: signed,
    notarize: signed,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    darkModeSupport: false
  },
  dmg: { sign: signed, title: 'Workroom ${version}', contents: [{ x: 150, y: 180 }, { x: 430, y: 180, type: 'link', path: '/Applications' }] },
  publish: null
};
