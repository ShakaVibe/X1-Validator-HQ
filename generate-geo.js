const fs = require('fs');

const RPC_URL = 'https://x1-testnet.xen.network';

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
  if (data.error) {
    throw new Error(`RPC Error: ${data.error.message}`);
  }
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
  
  // Extract IPs - only public IPs
  const ipSet = new Set();
  const validators = [];
  
  for (const node of clusterNodes) {
    if (node.gossip && nodeToVote[node.pubkey]) {
      const ip = node.gossip.split(':')[0];
      // Skip private IPs
      if (ip.startsWith('127.') || ip.startsWith('10.') || 
          ip.startsWith('192.168.') || ip.startsWith('0.')) {
        continue;
      }
      if (!ipSet.has(ip)) {
        ipSet.add(ip);
        validators.push({
          nodePubkey: node.pubkey,
          votePubkey: nodeToVote[node.pubkey],
          ip: ip
        });
      }
    }
  }
  
  return validators;
}

async function geolocateIP(ip) {
  try {
    const response = await fetch(`https://ipwho.is/${ip}`);
    const data = await response.json();
    if (data.success !== false && data.latitude) {
      return {
        country: data.country,
        countryCode: data.country_code,
        city: data.city,
        lat: data.latitude,
        lon: data.longitude
      };
    }
  } catch (e) {
    console.error(`Failed to geolocate ${ip}:`, e.message);
  }
  return null;
}

async function main() {
  console.log('Fetching validators...');
  
  let validators;
  try {
    validators = await getValidatorIPs();
    console.log(`Found ${validators.length} validators with unique IPs`);
  } catch (e) {
    console.error('Failed to fetch validators:', e.message);
    process.exit(1);
  }
  
  // Load existing location data to avoid re-geolocating
  let existingLocations = {};
  try {
    const data = fs.readFileSync('validator-locations.json', 'utf8');
    const parsed = JSON.parse(data);
    if (parsed.locations) {
      existingLocations = parsed.locations;
      console.log(`Loaded ${Object.keys(existingLocations).length} existing locations`);
    }
  } catch (e) {
    console.log('No existing data found, starting fresh');
  }
  
  // Process validators - geolocate new IPs
  const locations = {};
  const countries = {};
  let newCount = 0;
  let apiCalls = 0;
  const maxApiCalls = 40; // Stay under rate limit
  
  for (const v of validators) {
    const ip = v.ip;
    
    // Check if we already have this IP
    if (existingLocations[ip] && existingLocations[ip].lat) {
      locations[ip] = existingLocations[ip];
      
      // Count country
      const cc = existingLocations[ip].countryCode;
      if (cc) {
        if (!countries[cc]) {
          countries[cc] = { name: existingLocations[ip].country, count: 0 };
        }
        countries[cc].count++;
      }
      continue;
    }
    
    // Need to geolocate
    if (apiCalls >= maxApiCalls) {
      console.log('Rate limit reached, will continue next run');
      continue;
    }
    
    console.log(`Geolocating ${ip}...`);
    const geo = await geolocateIP(ip);
    apiCalls++;
    
    if (geo) {
      locations[ip] = geo;
      newCount++;
      
      // Count country
      const cc = geo.countryCode;
      if (cc) {
        if (!countries[cc]) {
          countries[cc] = { name: geo.country, count: 0 };
        }
        countries[cc].count++;
      }
    }
    
    // Delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 250));
  }
  
  console.log(`Added ${newCount} new locations, total: ${Object.keys(locations).length}`);
  
  // Build output in the format the dashboard expects
  const output = {
    lastUpdated: new Date().toISOString(),
    totalNodes: validators.length,
    totalLocations: Object.keys(locations).length,
    locations: locations,
    countries: countries
  };
  
  // Save results
  fs.writeFileSync('validator-locations.json', JSON.stringify(output, null, 2));
  console.log('Saved to validator-locations.json');
}

main().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
