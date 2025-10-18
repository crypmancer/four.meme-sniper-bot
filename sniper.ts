import { ethers } from 'ethers';
import * as dotenv from 'dotenv';

// Load env vars (e.g., PRIVATE_KEY, SNIPER_CONTRACT_ADDRESS)
dotenv.config();

// BSC Mainnet addresses
const ADDRESSES = {
  FOUR_MEME_FACTORY: '0x5c952063c7fc8610ffdb798152d69f0b9550762b' as const, // Four.meme Token Factory
} as const;


// Primary QuickNode WebSocket URL (for critical operations - event monitoring, swaps)
const PROVIDER_URL = process.env.WS_PROVIDER_URL!;
const RPR_PROVIDER_URL = process.env.PROVIDER_URL!;


// Multiple BSC RPC endpoints for multi-broadcast (faster propagation)
const BSC_RPC_ENDPOINTS = [
  RPR_PROVIDER_URL,
  'https://bsc-dataseed1.binance.org',
  'https://bsc-dataseed2.binance.org',
  'https://bsc-dataseed3.binance.org',
  'https://bsc-dataseed4.binance.org',
  'https://bsc-dataseed1.defibit.io',
  'https://bsc-dataseed2.defibit.io',
  'https://bsc-dataseed1.ninicoin.io',
  'https://bsc-dataseed2.ninicoin.io',
];

// Private key from env (REQUIRED for swaps)
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) {
  throw new Error('PRIVATE_KEY not set in .env file!');
}

// Buy amount configuration (default 0.01 BNB)
const BUY_AMOUNT_BNB = process.env.BUY_AMOUNT_BNB || '0.0001';


// NEW: ABI for Four.meme TokenCreate event (updated based on four.meme.json ABI)
const FOUR_MEME_ABI = [
  'event TokenCreate(address creator, address token, uint256 requestId, string name, string symbol, uint256 totalSupply, uint256 launchTime, uint256 launchFee)',
  // Purchase functions from four.meme.json
  'function purchaseToken(address token, uint256 amount, uint256 maxFunds) external payable',
  'function purchaseTokenAMAP(address token, uint256 funds, uint256 minAmount) external payable',
] as const;


// Initialize multiple RPC providers for broadcasting
const rpcProviders: ethers.JsonRpcProvider[] = BSC_RPC_ENDPOINTS.map(
  url => new ethers.JsonRpcProvider(url)
);

// OPTIMIZED: Multi-RPC broadcast - Submit signed tx to multiple RPCs simultaneously
async function submitRawTx(rawTx: string, timeoutMs = 5000): Promise<string> {
  const start = Date.now();
  
  // Add 0x prefix if missing
  const txWithPrefix = rawTx.startsWith('0x') ? rawTx : '0x' + rawTx;
  
  console.log('📤 Broadcasting to', rpcProviders.length, 'RPC endpoints...');
  
  // Submit to all RPCs simultaneously
  const submissions = rpcProviders.map(async (provider, index) => {
    try {
      const response = await Promise.race([
        provider.broadcastTransaction(txWithPrefix),
        new Promise<never>((_, reject) => 
          setTimeout(() => reject(new Error('Timeout')), timeoutMs)
        )
      ]);
      
      if (!response || !response.hash) {
        throw new Error('No transaction hash returned');
      }
      
      console.log(`  ✅ RPC ${index + 1} accepted (${Date.now() - start}ms)`);
      return { success: true, hash: response.hash, provider: index };
    } catch (err: any) {
      console.log(`  ⚠️  RPC ${index + 1} failed: ${err.message.substring(0, 50)}`);
      return { success: false, error: err.message, provider: index };
    }
  });

  // Wait for first successful response
  const results = await Promise.allSettled(submissions);
  
  // Find first successful submission
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value.success && result.value.hash) {
      const txHash = result.value.hash;
      console.log(`✅ Transaction broadcast successful: ${txHash}`);
      
      // Let other submissions complete in background (don't await)
      Promise.allSettled(submissions).then(() => {
        const successCount = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
        console.log(`📊 Final: ${successCount}/${rpcProviders.length} RPCs accepted tx`);
      });
      
      return txHash;
    }
  }
  
  // All failed
  throw new Error('All RPC endpoints failed to broadcast transaction');
}

// Function to buy tokens directly from Four.meme contract
async function buyTokenFromFourMeme(
  tokenAddress: string,
  amountInBNB: string,
  wallet: ethers.Wallet,
  fourMemeContract: ethers.Contract,
  currentNonce: { value: number }
): Promise<{ success: boolean; txHash?: string; error?: string }> {
  const start = Date.now();
  
  try {
    console.log(`🛒 BUYING TOKEN: ${amountInBNB} BNB worth of tokens from ${tokenAddress}`);
    
    const funds = ethers.parseEther(amountInBNB);
    const minAmount = 0n; // Set minimum amount to 0 for maximum purchase
    
    // Get gas price
    const feeData = await wallet.provider!.getFeeData();
    const gasPrice = feeData.gasPrice || ethers.parseUnits('3', 'gwei');
    
    // Populate transaction for buyWithEth (buy with BNB amount)
    const txRequest = await fourMemeContract.purchaseTokenAMAP.populateTransaction(
      tokenAddress,
      funds,
      minAmount,
      {
        gasLimit: 300000n,
        gasPrice: gasPrice,
        nonce: currentNonce.value,
        value: funds, // Send BNB as msg.value
        chainId: 56n,
      }
    );

    const signedTx = await wallet.signTransaction(txRequest);
    const rawTx = signedTx.slice(2); // Remove 0x prefix

    console.log(`📝 Transaction signed (${Date.now() - start}ms)`);

    // Submit transaction via multi-RPC broadcast
    const txHash = await submitRawTx(rawTx, 5000);
    
    console.log(`✅ Token purchase submitted: ${txHash}`);
    currentNonce.value++; // Increment nonce

    return { success: true, txHash };
    
  } catch (error: any) {
    console.error(`❌ Token purchase failed (${Date.now() - start}ms): ${error.message}`);
    return { success: false, error: error.message };
  }
}

async function main() {
  console.log('🚀 Starting Multi-RPC sniper...');
  console.log(`📡 Configured ${rpcProviders.length} RPC endpoints for broadcasting`);

  // Connect to BSC via WebSocket for events (read-only)
  const provider = new ethers.WebSocketProvider(PROVIDER_URL);
  console.log('Connected to BSC WebSocket provider (event monitoring)...');


  // Initialize wallet and contracts
  const wallet = new ethers.Wallet(PRIVATE_KEY!, provider);
  console.log(`Wallet address: ${wallet.address}`);

  // Initialize Four.meme Factory for TokenCreate events (read-only)
  const fourMemeFactory = new ethers.Contract(ADDRESSES.FOUR_MEME_FACTORY, FOUR_MEME_ABI, provider);
  
  // Initialize Four.meme contract with signer for buying tokens
  const fourMemeContract = new ethers.Contract(ADDRESSES.FOUR_MEME_FACTORY, FOUR_MEME_ABI, wallet);

  // NEW: Manual nonce management for speed - use object reference for mutation
  const currentNonce = { value: await provider.getTransactionCount(wallet.address, 'pending') };



  // This detects token deployments even earlier than pair creation (pre-liquidity)
  console.log('🔍 Enabling Four.meme TokenCreate monitoring...');
  fourMemeFactory.on('TokenCreate', async (creator: string, token: string, requestId: bigint, name: string, symbol: string, totalSupply: bigint, launchTime: bigint, launchFee: bigint, event: any) => {
    const eventStart = Date.now();

    // Target found! Log and execute
    console.log(`\n🚨 FOUR.MEME TOKEN CREATE DETECTED `, new Date());
    console.log(`  Token: ${token}`);
    console.log(`  Request ID: ${requestId.toString()}`);
    console.log(`  Name: ${name}`);
    console.log(`  Symbol: ${symbol}`);
    console.log(`  Creator: ${creator}`);
    console.log(`  Total Supply: ${totalSupply.toString()}`);
    console.log(`  Launch Time: ${new Date(Number(launchTime) * 1000).toISOString()}`);
    console.log(`  Launch Fee: ${launchFee.toString()}`);
    console.log(`  Block: ${event.log?.blockNumber || 'unknown'}`);
    console.log(`  Time: ${new Date().toISOString()}`);
    console.log('─'.repeat(60));

    // CRITICAL: Buy tokens immediately when new token is created
    buyTokenFromFourMeme(token, BUY_AMOUNT_BNB, wallet, fourMemeContract, currentNonce)
      .then(result => {
        if (result.success) {
          console.log(`🎯 Token purchase successful: ${result.txHash}`);
        } else {
          console.error(`❌ Token purchase failed: ${result.error}`);
        }
      })
      .catch(err => {
        console.error('Token purchase execution error:', err.message);
      });
  });

  // MEMPOOL MONITORING: Detect createPair BEFORE it's mined (for same-block attempts)
  console.log('🔍 Enabling mempool monitoring for early detection...');

  // OPTIMIZED: Nonce refresh every 30s to stay synced
  setInterval(async () => {
    const latestNonce = await provider.getTransactionCount(wallet.address, 'pending');
    if (latestNonce > currentNonce.value) {
      console.log(`⚙️  Nonce updated: ${currentNonce.value} → ${latestNonce}`);
      currentNonce.value = latestNonce;
    }
  }, 30000);

  console.log(`✅ Sniper ready! Monitoring for new tokens and will auto-buy ${BUY_AMOUNT_BNB} BNB worth...\n`);

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down...');
    provider.destroy();
    process.exit(0);
  });
}

main().catch(console.error);

// simulateTx().catch(console.error);