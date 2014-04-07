var  _       = require('underscore'),
    async   = require('async'),
    db      = require('../lib/db'),
    github  = require('../lib/github'),
    config  = require('../config'),
    notify  = require('./notifications'),
    Apn     = require('./apn').Apn;

// Contains logic for sending and receiving feedback for Apple's Push Notifications
var apn = new Apn(config.push.serviceGateway, config.push.feedbackGateway, config.push.cert, config.push.key);

// Do something on feedback from APN service
apn.feedback.on('feedback', function(feedbackData) {
    var tasks = _.map(feedbackData, function(i) {
        return function(callback) {
            console.log('device %s has been unresponsive since %s', i.device, i.time);
            db.removeExpiredRegistration(i.device, function(err) {
                if (err) console.err(err);
                callback(null);
            })
        };
    });

    console.log('Feedback service reports %s unresponsive devices', feedbackData.length);
    async.series(tasks);
});


/**
 * Process a record
 * @param row The row in the database
 * @param callback The
 */
function processRecord(record, callback) {
    var client = new github.Client(record.domain, record.oauth, record.username);

    // Convert the date object in the database
    var updatedDate = Date.parse(record.updated_at);
    if (isNaN(updatedDate)) {
        updatedDate = new Date(0);
    } else {
        updatedDate = new Date(updatedDate);
    }

    notify.processNotifications(client, updatedDate, function(err, lastModified, results) {
        if (err) {
            console.error('Error procesing registrations: %s - %s', err, err.stack);

            if (err.message === 'Bad credentials') {
                console.error('Removing %s at %s for bad credentials', record.oauth, record.domain);
                return db.removeBadAuth(record.oauth, record.domain, function() {
                    callback();
                });
            }
            else {
                results = [];
                lastModified = new Date();
            }
        }

        if (results !== undefined && results.length > 0) {
            _.each(results, function(result) {
                //console.log('pushing to %s: %s', record.tokens, result.msg);
                apn.send(record.tokens.split(','), result.msg, result.data);
            });
        }

        db.updateUpdatedAt(record.oauth, record.domain, lastModified, function(err) {
            if (err) console.error(err);
            callback();
        });
    });
}


function registrationLoop(callback) {
    var tasks = [];
    db.getRegistrations(
        function(err) {
            if (err) {
                console.error(err)
            } else {
                callback(tasks);
            }
        },
        function(row) {
            tasks.push(function(callback) { processRecord(row, callback); });
        });
}

function main() {
    var timeStart = new Date();
    console.log('Staring update loop at %s', timeStart.toString());
    registrationLoop(function(tasks) {
        var numberOfTasks = tasks.length;
        console.log('There are %s tasks to complete...', numberOfTasks);

        async.parallelLimit(tasks, 5, function() {
            var timeEnd = new Date();
            var diff = timeEnd - timeStart;
            console.log('%s tasks complete in %s minutes', numberOfTasks, (diff / 1000 / 60).toFixed(2));
            mainTimer();
        })
    });
}

function mainTimer() {
    setTimeout(main, 1000 * 60);
}

// Welcome!
main();

