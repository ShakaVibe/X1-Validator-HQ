const fs = require('fs');

const RPC_URL = 'https://x1-testnet-rpc.surge.sh';

async function rpcCall(method, params = []) {
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params
    })
  });
  const data = await response.json();
  return data.result;
}

async function getValidatorIPs() {
  const clusterNodes = await rpcCall('getClusterNodes');
  const voteAccounts = await rpcCall('getVoteAccounts');
  
  const allVoteAccounts = [
    ...voteAccounts.current,
    ...voteAccounts.delinquent
  ];
  
  // Map nodePubkey to voteAccount
  const nodeToVote = {};
  for (const v of allVoteAccounts) {
    nodeToVote[v.nodePubkey] = v.votePubkey;
  }
  
  // Extract IPs
  const validators = [];
  for (const node of clusterNodes) {
    if (node.gossip && nodeToVote[node.pubkey]) {
      const ip = node.gossip.split(':')[0];
      validators.push({
        nodePubkey: node.pubkey,
        votePubkey: nodeToVote[node.pubkey],
        ip: ip
      });
    }
  }
  
  return validators;
}

async function geolocateIP(ip) {
  try {
    const response = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,countryCode,region,city,lat,lon,isp`);
    const data = await response.json();
    if (data.status === 'success') {
      return {
        country: data.country,
        countryCode: data.countryCode,
        region: data.region,
        city: data.city,
        lat: data.lat,
        lon: data.lon,
        isp: data.isp
      };
    }
  } catch (e) {
    console.error(`Failed to geolocate ${ip}:`, e.message);
  }
  return null;
}

async function main() {
  console.log('Fetching validators...');
  const validators = await getValidatorIPs();
  console.log(`Found ${validators.length} validators with IPs`);
  
  // Load existing data
  let existing = {};
  try {
    const data = fs.readFileSync('validator-locations.json', 'utf8');
    const parsed = JSON.parse(data);
    for (const v of parsed) {
      existing[v.nodePubkey] = v;
    }
    console.log(`Loaded ${Object.keys(existing).length} existing locations`);
  } catch (e) {
    console.log('No existing data found, starting fresh');
  }
  
  // Process validators
  const results = [];
  let newCount = 0;
  let apiCalls = 0;
  const maxApiCalls = 45; // Stay under rate limit (45 per minute for free tier)
  
  for (const v of validators) {
    // Check if we already have this validator
    if (existing[v.nodePubkey] && existing[v.nodePubkey].lat) {
      results.push(existing[v.nodePubkey]);
      continue;
    }
    
    // Need to geolocate
    if (apiCalls >= maxApiCalls) {
      console.log(`Rate limit reached, skipping remaining new validators`);
      // Keep the validator without location
      results.push({
        nodePubkey: v.nodePubkey,
        votePubkey: v.votePubkey,
        ip: v.ip
      });
      continue;
    }
    
    console.log(`Geolocating ${v.ip}...`);
    const geo = await geolocateIP(v.ip);
    apiCalls++;
    
    if (geo) {
      results.push({
        nodePubkey: v.nodePubkey,
        votePubkey: v.votePubkey,
        ip: v.ip,
        ...geo
      });
      newCount++;
    } else {
      results.push({
        nodePubkey: v.nodePubkey,
        votePubkey: v.votePubkey,
        ip: v.ip
      });
    }
    
    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 100));
  }
  
  console.log(`Added ${newCount} new locations, total: ${results.length}`);
  
  // Save results
  fs.writeFileSync('validator-locations.json', JSON.stringify(results, null, 2));
  console.log('Saved to validator-locations.json');
}

main().catch(console.error);
