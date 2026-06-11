import { ConciergeError } from '@concierge/sdk';
import { toFunctionSelector } from 'viem';
import { LIFI_DIAMOND } from './_context.ts';

// BridgeData struct tuple encoding (ILiFi.BridgeData from lifinance/contracts)
const BD = '(bytes32,string,string,address,address,address,uint256,uint256,bool,bool)' as const;
// SwapData[] tuple encoding
const SD = '(address,address,address,address,uint256,bytes,bool)[]' as const;

// Pre-computed selectors for Li.Fi Diamond bridge entry points.
// Derived from canonical lifinance/contracts v2 ABIs. Restricts session keys
// to known bridge functions — no wildcard targets.
export const BRIDGE_FUNCTION_SELECTORS = [
  toFunctionSelector(
    `startBridgeTokensViaAcrossV3(${BD},(address,address,address,uint256,uint256,uint32,int64,uint32,bytes))`,
  ),
  toFunctionSelector(
    `swapAndStartBridgeTokensViaAcrossV3(${BD},${SD},(address,address,address,uint256,uint256,uint32,int64,uint32,bytes))`,
  ),
  toFunctionSelector(
    `startBridgeTokensViaStargate(${BD},(uint32,uint16,address,uint256,uint256,bytes,address))`,
  ),
  toFunctionSelector(
    `swapAndStartBridgeTokensViaStargate(${BD},${SD},(uint32,uint16,address,uint256,uint256,bytes,address))`,
  ),
  toFunctionSelector(
    `startBridgeTokensViaHop(${BD},(address,address,address,uint256,uint256,uint256,uint256,bytes32))`,
  ),
] as `0x${string}`[];

const SELECTOR_WHITELIST = new Set(BRIDGE_FUNCTION_SELECTORS);

// Static call policy — restrict session keys to Li.Fi Diamond only.
// For exact selector extraction from a live route, use buildCallPolicy(routeData).
export const callPolicy = {
  targets: [LIFI_DIAMOND] as [`0x${string}`],
  selectors: BRIDGE_FUNCTION_SELECTORS,
} as const;

// Dynamic policy builder — extracts the actual function selector from calldata
// and validates it against the known bridge function whitelist before returning.
// Throws ConfigError if the selector is not in the whitelist (guards against
// rogue API responses trying to authorize arbitrary calls on the Diamond).
export function buildCallPolicy(routeCalldata: `0x${string}`): typeof callPolicy {
  if (routeCalldata.length < 10) {
    throw new ConciergeError(
      'ConfigError',
      '[@concierge/lifi-bridge] buildCallPolicy: calldata too short to contain a function selector',
    );
  }
  const selector = routeCalldata.slice(0, 10) as `0x${string}`;
  if (!SELECTOR_WHITELIST.has(selector)) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/lifi-bridge] buildCallPolicy: selector ${selector} is not in the known bridge function whitelist — refusing to create session-key policy`,
    );
  }
  return { targets: [LIFI_DIAMOND], selectors: [selector] };
}
