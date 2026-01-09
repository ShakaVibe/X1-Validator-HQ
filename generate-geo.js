const fs = require('fs');

const RPC_URL = 'https://rpc.mainnet.x1.xyz';

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

async function getValidatorData() {
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
  
  // Track ALL validators and their IPs
  const allValidators = [];
  const uniqueIPs = new Set();
  const ipValidatorCount = {}; // How many validators per IP
  
  for (const node of clusterNodes) {
    if (node.gossip && nodeToVote[node.pubkey]) {
      const ip = node.gossip.split(':')[0];
      // Skip private IPs
      if (ip.startsWith('127.') || ip.startsWith('10.') || 
          ip.startsWith('192.168.') || ip.startsWith('0.')) {
        continue;
      }
      
      allValidators.push({
        nodePubkey: node.pubkey,
        votePubkey: nodeToVote[node.pubkey],
        ip: ip
      });
      
      uniqueIPs.add(ip);
      ipValidatorCount[ip] = (ipValidatorCount[ip] || 0) + 1;
    }
  }
  
  return {
    allValidators,
    uniqueIPs: Array.from(uniqueIPs),
    ipValidatorCount
  };
}

// Use ip-api.com batch endpoint (free, 100 IPs per batch, 45 requests/min)
async function batchGeolocate(ips) {
  const results = {};
  const batchSize = 100;
  
  for (let i = 0; i < ips.length; i += batchSize) {
    const batch = ips.slice(i, i + batchSize);
    console.log(`Geolocating batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(ips.length/batchSize)} (${batch.length} IPs)...`);
    
    try {
      const response = await fetch('http://ip-api.com/batch?fields=status,query,country,countryCode,city,lat,lon', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batch)
      });
      
      const data = await response.json();
      
      for (const item of data) {
        if (item.status === 'success') {
          results[item.query] = {
            country: item.country,
            countryCode: item.countryCode,
            city: item.city || 'Unknown',
            lat: item.lat,
            lon: item.lon
          };
        }
      }
    } catch (e) {
      console.error(`Batch failed:`, e.message);
    }
    
    // Rate limit: 45 requests per minute, so wait 1.5s between batches
    if (i + batchSize < ips.length) {
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  
  return results;
}

async function main() {
  console.log('Fetching validators from RPC...');
  
  let validatorData;
  try {
    validatorData = await getValidatorData();
    console.log(`Found ${validatorData.allValidators.length} total validators`);
    console.log(`Found ${validatorData.uniqueIPs.length} unique IPs`);
  } catch (e) {
    console.error('Failed to fetch validators:', e.message);
    process.exit(1);
  }
  
  if (validatorData.allValidators.length === 0) {
    console.error('No validators found!');
    process.exit(1);
  }
  
  // Load existing location data to preserve between runs
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
  
  // Find IPs that need geolocation
  const needGeo = validatorData.uniqueIPs.filter(ip => !existingLocations[ip] || !existingLocations[ip].lat);
  
  console.log(`Need to geolocate ${needGeo.length} new IPs`);
  
  // Geolocate new IPs
  let newLocations = {};
  if (needGeo.length > 0) {
    newLocations = await batchGeolocate(needGeo);
    console.log(`Got ${Object.keys(newLocations).length} new locations`);
  }
  
  // Merge existing and new locations
  const locations = { ...existingLocations, ...newLocations };
  
  // Only keep locations for current IPs (remove stale entries)
  const ipSet = new Set(validatorData.uniqueIPs);
  const activeLocations = {};
  for (const ip of Object.keys(locations)) {
    if (ipSet.has(ip)) {
      activeLocations[ip] = locations[ip];
    }
  }
  
  // Count TOTAL VALIDATORS by country (not unique IPs)
  const countries = {};
  let totalValidatorsCounted = 0;
  
  for (const ip of validatorData.uniqueIPs) {
    const loc = activeLocations[ip];
    const validatorCount = validatorData.ipValidatorCount[ip] || 1;
    
    if (loc && loc.countryCode) {
      if (!countries[loc.countryCode]) {
        countries[loc.countryCode] = { name: loc.country, count: 0 };
      }
      countries[loc.countryCode].count += validatorCount; // Add ALL validators at this IP
      totalValidatorsCounted += validatorCount;
    }
  }
  
  console.log(`Total locations (unique IPs): ${Object.keys(activeLocations).length}`);
  console.log(`Total validators counted: ${totalValidatorsCounted}`);
  console.log(`Countries: ${Object.keys(countries).length}`);
  
  // Build output
  const output = {
    lastUpdated: new Date().toISOString(),
    totalNodes: validatorData.allValidators.length,
    totalLocations: Object.keys(activeLocations).length,
    locations: activeLocations,
    countries: countries
  };
  
  // Save
  fs.writeFileSync('validator-locations.json', JSON.stringify(output, null, 2));
  console.log('Saved to validator-locations.json');
  
  // Show top countries
  const sorted = Object.entries(countries).sort((a, b) => b[1].count - a[1].count);
  console.log('\nTop countries:');
  sorted.slice(0, 10).forEach(([code, data]) => {
    console.log(`  ${code}: ${data.count} (${data.name})`);
  });
}

main().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
