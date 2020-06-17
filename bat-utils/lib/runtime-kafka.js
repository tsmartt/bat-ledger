const { NConsumer, NProducer } = require('sinek')
const SDebug = require('sdebug')
const debug = new SDebug('kafka')

const batchOptions = {
  batchSize: +(process.env.KAFKA_BATCH_SIZE || 10), // decides on the max size of our "batchOfMessages"
  commitEveryNBatch: 1, // will be ignored
  concurrency: 1, // will be ignored
  commitSync: false, // will be ignored
  noBatchCommits: true, // important, because we want to commit manually
  manualBatching: true, // important, because we want to control the concurrency of batches ourselves
  sortedManualBatch: true // important, because we want to receive the batch in a per-partition format for easier processing
}

class Kafka {
  constructor (config, runtime) {
    const { kafka } = config
    if (!kafka) {
      return
    }
    this.runtime = runtime
    this.config = kafka
    this.topicHandlers = {}
  }

  async connect () {
    // testing only
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Kafka producer not allowed in production')
    }

    const partitionCount = 1

    this.producer = new NProducer(this.config, null, partitionCount)
    this.producer.on('error', error => {
      console.error(error)
      if (this.runtime.captureException) {
        this.runtime.captureException(error)
      }
    })
    await this.producer.connect()
  }

  async send (topicName, message, _partition = null, _key = null, _partitionKey = null) {
    // return await producer.send("my-topic", "my-message", 0, "my-key", "my-partition-key")
    return this.producer.send(topicName, message, _partition, _key, _partitionKey)
  }

  on (topic, handler) {
    this.topicHandlers[topic] = handler
  }

  async consume () {
    const consumer = new NConsumer(Object.keys(this.topicHandlers), this.config)
    await consumer.connect()
    consumer.consume(async (batchOfMessages, callback) => {
      // parallel processing on topic level
      const topicPromises = Object.keys(batchOfMessages).map(async (topic) => {
        // parallel processing on partition level
        const topicPartitions = batchOfMessages[topic]
        const handler = this.topicHandlers[topic]
        const partitionKeys = Object.keys(topicPartitions)
        for (let i = 0; i < partitionKeys.length; i += 1) {
          const partitionKey = partitionKeys[i]
          const partitionMessages = topicPartitions[partitionKey]
          // sequential processing on message level (to respect ORDER)
          for (let j = 0; j < partitionMessages.length; j += 1) {
            const message = partitionMessages[j]
            try {
              await handler(message)
              consumer.commitOffsetHard(topic, partitionKey, message.offset)
            } catch (err) {
              // must break to not skip ahead to another partition
              // or set of messages
              debug('erred', topic, message, err)
              return {
                topic,
                message,
                err: {
                  message: err.message,
                  stack: err.stack
                }
              }
            }
          }
        }
      })

      let errors = await Promise.all(topicPromises)
      errors = errors.filter((error) => error)
      if (errors.length) {
        debug('errors', errors)
      }
      // callback still controlls the "backpressure"
      // as soon as you call it, it will fetch the next batch of messages
      callback()
    }, false, false, batchOptions)
  }
}

module.exports = function (config, runtime) {
  if (!(this instanceof Kafka)) return new Kafka(config, runtime)
}
