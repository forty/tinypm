const cluster = require('cluster');

//const command = process.argv[2];
const script = './server.js'
const count = 3;
const disconnectTimeout = 5000;
const bootTimeout = 5000;

let currentVersion = 0;
let targetVersion = currentVersion;
let targetCount = count;

let workerStatus = {}; //booting / online / dying
let workerVersion = {};
let workerDisconnectTO = {};
let workerBootTO = {};

const setup = () => {
    cluster.setupMaster({
        exec: script,
        argv: [
            'worker'
        ]
    });
    targetVersion += 1;
};

const workerWithStatus = (status, versionFilter) => {
    return Object.keys(cluster.workers).filter((workerId) => {
        return workerStatus[workerId] === status && versionFilter(workerVersion[workerId]);
    });
};

const currentOnline = () => workerWithStatus('online', version => version === currentVersion);
const targetOnline = () => workerWithStatus('online', version => version === targetVersion);
const deprecatedOnline = () => workerWithStatus('online', version => version !== currentVersion && version !== targetVersion);
const currentBooting = () => workerWithStatus('booting', version => version === currentVersion);
const targetBooting = () => workerWithStatus('booting', version => version === targetVersion);
const depredatedBooting = () => workerWithStatus('booting', version => version !== currentVersion && version !== targetVersion);
const currentAlive = () => currentOnline().concat(currentBooting());
const targetAlive = () => targetOnline().concat(targetBooting());
const deprecatedAlive = () => deprecatedOnline().concat(depredatedBooting());

const disconnect = (workerId) => {
    const worker = cluster.workers[workerId];
    worker.send('shutdown');
    worker.disconnect();
    workerStatus[workerId] = 'dying';
    workerDisconnectTO[workerId] = setTimeout(() => {
        handleEvent({
            event: 'timeout_disconnect',
            workerId: workerId
        });
        worker.kill();
    }, disconnectTimeout);
};
const disconnectMany = (workerIds) => {
    workerIds.forEach((workerId) => {
        disconnect(workerId);
    });
};
const spawnWorker = () => {
    const worker = cluster.fork();
    workerStatus[worker.id] = 'booting';
    workerVersion[worker.id] = targetVersion;
    workerBootTO[worker.id] = setTimeout(() => {
        handleEvent({
            event: 'timeout_boot',
            workerId: worker.id
        });
        worker.kill();
    }, bootTimeout);
};
const spawnWorkers = (count) => {
    for (let i = 0; i < count; i++) {
        spawnWorker();
    }
};

const fixState = () => {
    if (targetVersion === currentVersion) {
        // we are at the target version
        // we need to make sure to kill all the deperecated processes
        // and to adjust the number of current workers in case we have too many or not enough

        disconnectMany(deprecatedAlive());

        const currentAliveCount = currentAlive().length;
        if (currentAliveCount > targetCount) {
            // too many workers
            if (currentBooting().length === 0) { // don't lower the number of worker if some are still booting
                const toRemove = currentAliveCount - targetCount;
                disconnectMany(currentAlive().slice(0, toRemove));
            }
        } else if (currentAliveCount < targetCount) {
            // not enough workers
            const toAdd = targetCount - currentAliveCount;
            spawnWorkers(toAdd);
        } else {
            // nothing to do, unless target count is zero, then we need to exit
            if (targetCount === 0) {
                process.exit(0);
            }
        }
    } else if (targetVersion > currentVersion) {
        // we want to replace the processes

        const targetAliveCount = targetAlive().length;
        const targetOnlineCount = targetOnline().length;
        if (targetAliveCount < targetCount) {
            // make sure there are enough target worker started
            const toAdd = targetCount - targetAliveCount;
            spawnWorkers(toAdd);
        } else if (targetOnlineCount >= targetCount) {
            // we have finished restarting enough workers, we can update the current version
            // and kill the previous workers
            currentVersion = targetVersion;
            fixState();
        }
    } else {
        // should not happen
    }
};

const handleEvent = (event) => {
    console.log('Event', JSON.stringify(event));
    switch (event.event) {
        case 'exit':
            delete workerStatus[event.workerId];
            delete workerVersion[event.workerId];
            if (workerDisconnectTO[event.workerId]) {
                clearTimeout(workerDisconnectTO[event.workerId]);
                delete workerDisconnectTO[event.workerId];
            }
            if (workerBootTO[event.workerId]) {
                clearTimeout(workerBootTO[event.workerId]);
                delete workerBootTO[event.workerId];
            }
            break;
        case 'message_online':
            workerStatus[event.workerId] = 'online';
            if (workerBootTO[event.workerId]) {
                clearTimeout(workerBootTO[event.workerId]);
            }
            break;
        case 'message_shutdown':
            disconnect(event.workerId);
            break;
        case 'signal_SIGHUP':
            setup();
            break;
        default:
    }
    fixState();
    console.log('Status', JSON.stringify(workerStatus));
    console.log('Version', JSON.stringify(workerVersion));
};

['disconnect', 'exit', 'fork', 'listening', 'message', 'online'].forEach((event) => {
    cluster.on(event, (worker, value1) => {
        if (event === 'message') {
            event = `message_${value1}`
        }
        handleEvent({
            event: event,
            workerId: worker.id
        });
    });
});

process.on('SIGHUP', () => {
    handleEvent({ event: 'signal_SIGHUP' });
});

// bootstrap by pretending we have received an initial SIGHUP
handleEvent({ event: 'signal_SIGHUP' });
