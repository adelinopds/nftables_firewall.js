const sysClassNetInterfaces = '/sys/class/net/';
const fs = require('fs');
const nfq = require('nfqueue');
const IPv4 = require('pcap/decode/ipv4');
const { exec } = require('child_process');
const nft = require('./nftables')({ exec: exec });
const netFilterPacket = require('./nfpacket')({ nfq: nfq, pcapIPv4: IPv4 });
const actions = require('./actions')({ fs: fs });

// The buffer size we will use binding to nfqueues.
const buffer = 131070;

process.stdout.write('\x1Bc');

let rules = require('./../config/rules.json').rules;
let systemInterfaces = require('./../config/interfaces.json').interfaces;

fs.watch('./config', checkConfig);

function checkConfig (eventType, filename) {
  setTimeout(() => {
    switch (filename) {
      case 'rules.json':
        console.log('Rules Configuration Changed - Reloding..');
        fs.readFile('./config/rules.json', 'utf8', (err, data) => {
          if (err) throw err;
          let newRules = JSON.parse(data);
          rules = newRules.rules;
        });
        break;
      case 'interfaces.json':
        console.log('Interfaces Configuration Changed - Reloding..');
        fs.readFile('./config/interfaces.json', 'utf8', (err, data) => {
          if (err) throw err;
          let newInterfaces = JSON.parse(data);
          Object.keys(newInterfaces.interfaces).forEach(newNetworkInterface => {
            interfaces.forEach(thisInterface => {
              if (thisInterface.name === newNetworkInterface && thisInterface.zone !== newInterfaces.interfaces[newNetworkInterface].zone) {
                thisInterface.zone = newInterfaces.interfaces[newNetworkInterface].zone;
              }
            });
          });

          systemInterfaces = newInterfaces.interfaces;
        });
        break;
    }
  }, 500);
}

// Some counters for connection analysis (Used for stdio)
let packetsIn = 0;
let packetsInAccept = 0;
let packetsOut = 0;
let packetsOutAccept = 0;

// An array to store our interfaces.
let interfaces = [];

// Sets base rules, with default to 'drop', but allows established and related connections.
function insertFinalCounters () {
  return Promise.all([
    nft.add('rule ip filter input counter'),
    nft.add('rule ip filter output counter')
  ]);
}

function insertInterfaceRules (networkInterface) {
  return Promise.all([
    nft.add('rule ip filter input iif ' + networkInterface.name + ' counter nftrace set 1 queue num ' + networkInterface.number),
    // nft.add('rule ip filter input iif ' + networkInterface.name + ' meta mark 9999 counter nftrace set 1 queue num 200' + networkInterface.number),
    nft.add('rule ip filter output oif ' + networkInterface.name + ' counter nftrace set 1 queue num 100' + networkInterface.number)
    // nft.add('rule ip filter output oif ' + networkInterface.name + ' meta mark 9999 counter nftrace set 1 queue num 210' + networkInterface.number)
  ]);
}

function getInterfaces (path) {
  const interfaces = fs.readdirSync(path);

  return interfaces instanceof (Array)
    ? interfaces
    : [];
}

/**
 * Runs promises from promise array in chained manner
 *
 * @param {array} arr - promise arr
 * @return {Object} promise object
 */
function runPromiseArrayInSequence (arr) {
  return arr.reduce((promiseChain, currentPromise) => {
    return promiseChain.then((chainedResult) => {
      return currentPromise(chainedResult)
        .then((res) => res);
    });
  }, Promise.resolve());
}

function setupInterfaces () {
  let interfacePromises = [];

  getInterfaces(sysClassNetInterfaces).forEach(networkInterface => {
    let zone = 'untrusted';
    if (systemInterfaces[networkInterface] && systemInterfaces[networkInterface].zone) {
      zone = systemInterfaces[networkInterface].zone || 'untrusted';
    }
    let newInterface = { name: networkInterface, number: interfaces.length + 1, zone };
    interfacePromises.push(() => insertInterfaceRules(newInterface));
    interfaces.push(newInterface);
  });

  return runPromiseArrayInSequence(interfacePromises);
}

function handleActions (action, packet) {
  switch (action) {
    case 'log':
      actions.log(JSON.stringify(packet));
      break;
    default:
      break;
  }
}

function handlePacket (packet) {
  // Check we even handle this protocol
  if (rules[packet.direction][packet.nfpacketDecoded.protocol.toString()]) {
    // Check if the global (blanket) rule applies
    if (rules[packet.direction][packet.nfpacketDecoded.protocol.toString()].global.policy && rules[packet.direction][packet.nfpacketDecoded.protocol.toString()].global.policy === 'allow') {
      // Trigger the callback, if it exists..
      if (rules[packet.direction][packet.nfpacketDecoded.protocol.toString()].global.action) {
        handleActions(rules[packet.direction][packet.nfpacketDecoded.protocol.toString()].global.action, packet);
      }
      // Check if the global setting has any specific ports
      if (rules[packet.direction][packet.nfpacketDecoded.protocol.toString()].global.ports) {
        // Check, if there are ports, if the port is allowed.
        if (rules[packet.direction][packet.nfpacketDecoded.protocol.toString()].global.ports[packet.nfpacketDecoded.payload.dport]) {
          // Check if the policy is allow
          if (rules[packet.direction][packet.nfpacketDecoded.protocol.toString()].global.ports[packet.nfpacketDecoded.payload.dport].policy && rules[packet.direction][packet.nfpacketDecoded.protocol.toString()].global.ports[packet.nfpacketDecoded.payload.dport].policy === 'allow') {
            // Set to accept packet.
            packet.verdict = packet.enums.netfilterVerdict.NF_ACCEPT;
          }
          // Finally - if the port is allowed, check if there's a callback to trigger.
          if (rules[packet.direction][packet.nfpacketDecoded.protocol.toString()].global.ports[packet.nfpacketDecoded.payload.dport].action) {
            handleActions(rules[packet.direction][packet.nfpacketDecoded.protocol.toString()].global.ports[packet.nfpacketDecoded.payload.dport].action, packet);
          }
          // Do not further traverse ruleset, or this function ; wasted cycles.
          return packet.verdicts.getVerdict();
        }

        // The global default is enabled, yet there is no ports key..
        //    (Likely) means this is a port-less protocol, or a blanket 'allow' rule is in place.
      } else {
        packet.verdict = packet.enums.netfilterVerdict.NF_ACCEPT;
        return packet.verdicts.getVerdict();
        // packet.nfpacket.setVerdict(packet.verdict, packet.mark);
      }
      // Else, as if globally accepted we don't need to traverse other zones.
    }
    // Check if the protocol is zone allowed.
    if (rules[packet.direction][packet.nfpacketDecoded.protocol.toString()][packet.networkInterface.zone].policy && rules[packet.direction][packet.nfpacketDecoded.protocol.toString()][packet.networkInterface.zone].policy === 'allow') {
      // Trigger the protocol zone callback, if it exists.
      if (rules[packet.direction][packet.nfpacketDecoded.protocol.toString()][packet.networkInterface.zone].action) {
        handleActions(rules[packet.direction][packet.nfpacketDecoded.protocol.toString()][packet.networkInterface.zone].action, packet);
      }
      // Check if the protocol's zone setting has any specific ports
      if (rules[packet.direction][packet.nfpacketDecoded.protocol.toString()][packet.networkInterface.zone].ports) {
        // Check, if there are ports, if the port is allowed.
        if (rules[packet.direction][packet.nfpacketDecoded.protocol.toString()][packet.networkInterface.zone].ports[packet.nfpacketDecoded.payload.dport] && rules[packet.direction][packet.nfpacketDecoded.protocol.toString()][packet.networkInterface.zone].ports[packet.nfpacketDecoded.payload.dport].policy && rules[packet.direction][packet.nfpacketDecoded.protocol.toString()][packet.networkInterface.zone].ports[packet.nfpacketDecoded.payload.dport].policy === 'allow') {
          packet.verdict = packet.enums.netfilterVerdict.NF_ACCEPT;
          // Finally - if the port is allowed, check if there's a callback to trigger.
          if (rules[packet.direction][packet.nfpacketDecoded.protocol.toString()][packet.networkInterface.zone].ports[packet.nfpacketDecoded.payload.dport].action) {
            handleActions(rules[packet.direction][packet.nfpacketDecoded.protocol.toString()][packet.networkInterface.zone].ports[packet.nfpacketDecoded.payload.dport].action, packet);
          }
        }
        // The global default is enabled, yet there are no ports.. which likely
        //    Means this is a port-less protocol.
      } else {
        packet.verdict = packet.enums.netfilterVerdict.NF_ACCEPT;
      }
    }
  }

  // Handles 'related' connections
  //  TO DO - Does not confirm state of a connection. Theoretically; this could be exploited.
  //    Basically; actor could force outgoing port as a trusted port and ggwp.
  if ((packet.direction) === 'incoming') {
    if (rules['outgoing'][packet.nfpacketDecoded.protocol.toString()]) {
      // console.log('Protocol: %s, sport: %s, dport: %s', packet.nfpacketDecoded.protocol.toString(), packet.nfpacketDecoded.payload.sport, packet.nfpacketDecoded.payload.dport);
      if (rules['outgoing'][packet.nfpacketDecoded.protocol.toString()].global && rules['outgoing'][packet.nfpacketDecoded.protocol.toString()].global.ports && rules['outgoing'][packet.nfpacketDecoded.protocol.toString()].global.ports[packet.nfpacketDecoded.payload.sport]) {
        // Check if the policy is allow
        if (rules['outgoing'][packet.nfpacketDecoded.protocol.toString()].global.ports[packet.nfpacketDecoded.payload.sport].policy && rules['outgoing'][packet.nfpacketDecoded.protocol.toString()].global.ports[packet.nfpacketDecoded.payload.sport].policy === 'allow') {
          // Set to accept packet.
          packet.verdict = packet.enums.netfilterVerdict.NF_ACCEPT;
        }
        // Finally - if the port is allowed, check if there's a callback to trigger.
        if (rules['outgoing'][packet.nfpacketDecoded.protocol.toString()].global.ports[packet.nfpacketDecoded.payload.sport].action) {
          handleActions(rules['outgoing'][packet.nfpacketDecoded.protocol.toString()].global.ports[packet.nfpacketDecoded.payload.sport].action, packet);
        }
        // Do not further traverse ruleset, or this function ; wasted cycles.
        return packet.verdicts.getVerdict();
        // packet.nfpacket.setVerdict(packet.verdict, packet.mark);
      }
    }
    if (rules['outgoing'][packet.nfpacketDecoded.protocol.toString()][packet.networkInterface.zone] && rules['outgoing'][packet.nfpacketDecoded.protocol.toString()][packet.networkInterface.zone].ports && rules['outgoing'][packet.nfpacketDecoded.protocol.toString()][packet.networkInterface.zone].ports[packet.nfpacketDecoded.payload.sport] && rules['outgoing'][packet.nfpacketDecoded.protocol.toString()][packet.networkInterface.zone].ports[packet.nfpacketDecoded.payload.sport].policy && rules['outgoing'][packet.nfpacketDecoded.protocol.toString()][packet.networkInterface.zone].ports[packet.nfpacketDecoded.payload.sport].policy === 'allow') {
      packet.verdict = packet.enums.netfilterVerdict.NF_ACCEPT;
      // Finally - if the port is allowed, check if there's a callback to trigger.
      if (rules['outgoing'][packet.nfpacketDecoded.protocol.toString()][packet.networkInterface.zone].ports[packet.nfpacketDecoded.payload.sport].action) {
        handleActions(rules['outgoing'][packet.nfpacketDecoded.protocol.toString()][packet.networkInterface.zone].ports[packet.nfpacketDecoded.payload.sport].action, packet);
      }
    }
  }

  return packet.verdicts.getVerdict();
}

function updateOutput () {
  process.stdout.write('\x1Bc');
  let packetsInReject = packetsIn - packetsInAccept;
  let packetsOutReject = packetsOut - packetsOutAccept;

  process.stdout.write('Packets: ' + (packetsIn + packetsOut) + ' - IN: ' + packetsIn + ' (A: ' + packetsInAccept + ' - R: ' + packetsInReject + ') - OUT: ' + packetsOut + ' (A: ' + packetsOutAccept + ' - R: ' + packetsOutReject + ')\r');// - Accepted: ' + packetsAccepted + ' (I: ' + packetsAcceptedIn + ' O: ' + packetsAcceptedOut + ') - Rejected: ' + packetsRejected + ' (I: ' + packetsRejectedIn + ' O: ' + packetsRejectedOut + ')\r');
}

function bindQueueHandlers () {
  interfaces.forEach(networkInterface => {
    networkInterface.queueIn = nfq.createQueueHandler(parseInt(networkInterface.number), buffer, (nfpacket) => {
      packetsIn++;
      let thisPacket = netFilterPacket(nfpacket);
      thisPacket.direction = 'incoming';
      thisPacket.networkInterface = networkInterface;

      thisPacket.encoding.decode();

      let verdict = handlePacket(thisPacket);

      if (verdict.name === 'accept') {
        packetsInAccept++;
      }

      verdict();
    });

    networkInterface.queueOut = nfq.createQueueHandler(parseInt('100' + networkInterface.number), buffer, (nfpacket) => {
      packetsOut++;
      let thisPacket = netFilterPacket(nfpacket);
      thisPacket.direction = 'outgoing';
      thisPacket.networkInterface = networkInterface;

      thisPacket.encoding.decode();

      let verdict = handlePacket(thisPacket);

      if (verdict.name === 'accept') {
        packetsOutAccept++;
      }

      verdict();
    });
  });
}

console.log('Flushing rules...');
nft.flush().then(
  (resolved) => {
    console.log('Injecting NFTables base ruleset...');
    nft.inject('./src/config/rules-base.nft');
  },
  (reject) => console.log('Failed to flush rules: ' + reject)
).then(
  (resolved) => {
    console.log('Configuring interfaces...');
    setupInterfaces();
  },
  (reject) => console.log('Failed to inject base rules: ' + reject)
).then(
  (resolved) => {
    console.log('Binding NFQueue handlers...');
    bindQueueHandlers();
  },
  (reject) => console.log('Failed to setup interfaces: ' + reject)
).then(
  (resolved) => {
    console.log('Inserting final (counter) rules...');
    setTimeout(insertFinalCounters, 2000);
  },
  (reject) => console.log('Failed to bind queue handlers: ' + reject)
).catch(
  (err) => console.log('Failed to insert final counters: ' + err)
);

setInterval(updateOutput, 250);
