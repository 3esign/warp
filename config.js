// Activation requires a verified V2 deployment, runtime fingerprint and release checks.
// Do not point this release at the unsafe legacy game.
window.WARP_CONFIG = Object.freeze({
  enabled: false,
  release: 'V2',
  chainId: '0x2105',
  contract: null,
  runtimeSha256: null,
  maxAgeMs: 90000,
  rpcUrls: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'],
  publicUrl: 'https://3esign.github.io/warp/',
  explorer: 'https://basescan.org/tx/',
  abi: {
  "state": "0xb7d0628b",
  "press": "0xc8b5da66",
  "settle": "0x6ffbfaa8",
  "claim": "0xfa93d8b5",
  "refund": "0xbffa55d5",
  "winnings": "0x68463349",
  "refunds": "0xb613b114",
  "events": {
    "press": "0xc1612c32a370c4152a87e7c909b398ab2d1f04406d09cad38eeab1dd890136bf",
    "settle": "0x35dd47c01df08fd5aa2d699c302f1d0594675076d2342ab6e16483cb75c2b7c5",
    "claim": "0x337c720c72dcd37eaac91eef9523788368a2d5f951c5e9cecbbf89635befa2fe",
    "refund": "0x39bed68a008a68cbf907d7ff6bc3629912af6516cb837cfa3f871ad9f2b8a944"
  }
}
});
