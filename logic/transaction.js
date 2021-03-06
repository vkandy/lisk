'use strict';

var bignum = require('../helpers/bignum.js');
var ByteBuffer = require('bytebuffer');
var constants = require('../helpers/constants.js');
var crypto = require('crypto');
var exceptions = require('../helpers/exceptions.js');
var ed = require('ed25519');
var extend = require('util-extend');
var slots = require('../helpers/slots.js');
var sql = require('../sql/transactions.js');

// Private fields
var __private = {}, genesisblock = null;

__private.types = {};

// Constructor
function Transaction (scope, cb) {
	this.scope = scope;
	genesisblock = this.scope.genesisblock;
	if (cb) {
		return setImmediate(cb, null, this);
	}
}

// Private methods
function calc (height) {
	return Math.floor(height / slots.delegates) + (height % slots.delegates > 0 ? 1 : 0);
}

// Public methods
Transaction.prototype.create = function (data) {
	if (!__private.types[data.type]) {
		throw Error('Unknown transaction type ' + data.type);
	}

	if (!data.sender) {
		throw Error('Invalid sender');
	}

	if (!data.keypair) {
		throw Error('Invalid keypair');
	}

	var trs = {
		type: data.type,
		amount: 0,
		senderPublicKey: data.sender.publicKey,
		requesterPublicKey: data.requester ? data.requester.publicKey.toString('hex') : null,
		timestamp: slots.getTime(),
		asset: {}
	};

	trs = __private.types[trs.type].create.call(this, data, trs);
	trs.signature = this.sign(data.keypair, trs);

	if (data.sender.secondSignature && data.secondKeypair) {
		trs.signSignature = this.sign(data.secondKeypair, trs);
	}

	trs.id = this.getId(trs);

	trs.fee = __private.types[trs.type].calculateFee.call(this, trs, data.sender) || false;

	return trs;
};

Transaction.prototype.attachAssetType = function (typeId, instance) {
	if (instance && typeof instance.create === 'function' && typeof instance.getBytes === 'function' &&
		typeof instance.calculateFee === 'function' && typeof instance.verify === 'function' &&
		typeof instance.objectNormalize === 'function' && typeof instance.dbRead === 'function' &&
		typeof instance.apply === 'function' && typeof instance.undo === 'function' &&
		typeof instance.applyUnconfirmed === 'function' && typeof instance.undoUnconfirmed === 'function' &&
		typeof instance.ready === 'function' && typeof instance.process === 'function'
	) {
		__private.types[typeId] = instance;
		return instance;
	} else {
		throw Error('Invalid instance interface');
	}
};

Transaction.prototype.sign = function (keypair, trs) {
	var hash = this.getHash(trs);
	return ed.Sign(hash, keypair).toString('hex');
};

Transaction.prototype.multisign = function (keypair, trs) {
	var bytes = this.getBytes(trs, true, true);
	var hash = crypto.createHash('sha256').update(bytes).digest();
	return ed.Sign(hash, keypair).toString('hex');
};

Transaction.prototype.getId = function (trs) {
	var hash = this.getHash(trs);
	var temp = new Buffer(8);
	for (var i = 0; i < 8; i++) {
		temp[i] = hash[7 - i];
	}

	var id = bignum.fromBuffer(temp).toString();
	return id;
};

Transaction.prototype.getHash = function (trs) {
	return crypto.createHash('sha256').update(this.getBytes(trs)).digest();
};

Transaction.prototype.getBytes = function (trs, skipSignature, skipSecondSignature) {
	if (!__private.types[trs.type]) {
		throw Error('Unknown transaction type ' + trs.type);
	}

	var bb;

	try {
		var assetBytes = __private.types[trs.type].getBytes.call(this, trs, skipSignature, skipSecondSignature);
		var assetSize = assetBytes ? assetBytes.length : 0;
		var i;

		bb = new ByteBuffer(1 + 4 + 32 + 32 + 8 + 8 + 64 + 64 + assetSize, true);
		bb.writeByte(trs.type);
		bb.writeInt(trs.timestamp);

		var senderPublicKeyBuffer = new Buffer(trs.senderPublicKey, 'hex');
		for (i = 0; i < senderPublicKeyBuffer.length; i++) {
			bb.writeByte(senderPublicKeyBuffer[i]);
		}

		if (trs.requesterPublicKey) {
			var requesterPublicKey = new Buffer(trs.requesterPublicKey, 'hex');
			for (i = 0; i < requesterPublicKey.length; i++) {
				bb.writeByte(requesterPublicKey[i]);
			}
		}

		if (trs.recipientId) {
			var recipient = trs.recipientId.slice(0, -1);
			recipient = bignum(recipient).toBuffer({size: 8});

			for (i = 0; i < 8; i++) {
				bb.writeByte(recipient[i] || 0);
			}
		} else {
			for (i = 0; i < 8; i++) {
				bb.writeByte(0);
			}
		}

		bb.writeLong(trs.amount);

		if (assetSize > 0) {
			for (i = 0; i < assetSize; i++) {
				bb.writeByte(assetBytes[i]);
			}
		}

		if (!skipSignature && trs.signature) {
			var signatureBuffer = new Buffer(trs.signature, 'hex');
			for (i = 0; i < signatureBuffer.length; i++) {
				bb.writeByte(signatureBuffer[i]);
			}
		}

		if (!skipSecondSignature && trs.signSignature) {
			var signSignatureBuffer = new Buffer(trs.signSignature, 'hex');
			for (i = 0; i < signSignatureBuffer.length; i++) {
				bb.writeByte(signSignatureBuffer[i]);
			}
		}

		bb.flip();
	} catch (e) {
		throw Error(e.toString());
	}

	return bb.toBuffer();
};

Transaction.prototype.ready = function (trs, sender) {
	if (!__private.types[trs.type]) {
		throw Error('Unknown transaction type ' + trs.type);
	}

	if (!sender) {
		return false;
	}

	return __private.types[trs.type].ready.call(this, trs, sender);
};

Transaction.prototype.process = function (trs, sender, requester, cb) {
	if (typeof requester === 'function') {
		cb = requester;
	}

	// Check transaction type
	if (!__private.types[trs.type]) {
		return setImmediate(cb, 'Unknown transaction type ' + trs.type);
	}

	// if (!this.ready(trs, sender)) {
	// 	return setImmediate(cb, 'Transaction is not ready: ' + trs.id);
	// }

	// Get transaction id
	var txId;

	try {
		txId = this.getId(trs);
	} catch (e) {
		this.scope.logger.error(e.toString());
		return setImmediate(cb, 'Failed to get transaction id');
	}

	// Check transaction id
	if (trs.id && trs.id !== txId) {
		return setImmediate(cb, 'Invalid transaction id');
	} else {
		trs.id = txId;
	}

	// Check sender
	if (!sender) {
		return setImmediate(cb, 'Missing sender');
	}

	// Equalize sender address
	trs.senderId = sender.address;

	// Check requester public key
	if (trs.requesterPublicKey) {
		if (sender.multisignatures.indexOf(trs.requesterPublicKey) < 0) {
			return setImmediate(cb, 'Invalid requester public key');
		}
	}

	// Verify signature
	if (trs.requesterPublicKey) {
		if (!this.verifySignature(trs, trs.requesterPublicKey, trs.signature)) {
			return setImmediate(cb, 'Failed to verify signature');
		}
	} else {
		if (!this.verifySignature(trs, trs.senderPublicKey, trs.signature)) {
			return setImmediate(cb, 'Failed to verify signature');
		}
	}

	// Call process on transaction type
	__private.types[trs.type].process.call(this, trs, sender, function (err, trs) {
		if (err) {
			return setImmediate(cb, err);
		}

		// Check for already confirmed transaction
		this.scope.db.one(sql.countById, { id: trs.id }).then(function (row) {
			if (row.count > 0) {
				return cb('Ignoring already confirmed transaction');
			}

			return cb(null, trs);
		}).catch(function (err) {
			this.scope.logger.error(err.toString());
			return cb('Transaction#process error');
		});
	}.bind(this));
};

Transaction.prototype.verify = function (trs, sender, requester, cb) {
	var valid;

	if (typeof requester === 'function') {
		cb = requester;
	}

	// Check transaction type
	if (!__private.types[trs.type]) {
		return setImmediate(cb, 'Unknown transaction type ' + trs.type);
	}

	// Check sender
	if (!sender) {
		return setImmediate(cb, 'Missing sender');
	}

	// Check sender public key
	if (sender.publicKey !== trs.senderPublicKey) {
		var err = 'Invalid sender public key';

		if (exceptions.senderPublicKey.indexOf(trs.id) > -1) {
			this.scope.logger.debug(err);
			this.scope.logger.debug(JSON.stringify(trs));
		} else {
			return setImmediate(cb, err);
		}
	}

	// Check sender address
	if (String(trs.senderId).toUpperCase() !== String(sender.address).toUpperCase()) {
		return setImmediate(cb, 'Invalid sender address');
	}

	// Check requester public key
	if (trs.requesterPublicKey) {
		if (sender.multisignatures.indexOf(trs.requesterPublicKey) < 0) {
			return setImmediate(cb, 'Invalid requester public key');
		}
	}

	// Verify signature
	try {
		valid = false;

		if (trs.requesterPublicKey) {
			valid = this.verifySignature(trs, trs.requesterPublicKey, trs.signature);
		} else {
			valid = this.verifySignature(trs, trs.senderPublicKey, trs.signature);
		}
	} catch (e) {
		this.scope.logger.error(e.toString());
		return setImmediate(cb, e.toString());
	}

	if (!valid) {
		return setImmediate(cb, 'Failed to verify signature');
	}

	// Verify second signature
	if (!trs.requesterPublicKey && sender.secondSignature) {
		try {
			valid = this.verifySecondSignature(trs, sender.secondPublicKey, trs.signSignature);
		} catch (e) {
			return setImmediate(cb, e.toString());
		}
		if (!valid) {
			return setImmediate(cb, 'Failed to verify second signature');
		}
	} else if (trs.requesterPublicKey && requester.secondSignature) {
		try {
			valid = this.verifySecondSignature(trs, requester.secondPublicKey, trs.signSignature);
		} catch (e) {
			return setImmediate(cb, e.toString());
		}
		if (!valid) {
			return setImmediate(cb, 'Failed to verify second signature');
		}
	}

	// Check that signatures are unique
	if (trs.signatures && trs.signatures.length) {
		var signatures = trs.signatures.reduce(function (p, c) {
			if (p.indexOf(c) < 0) { p.push(c); }
			return p;
		}, []);

		if (signatures.length !== trs.signatures.length) {
			return setImmediate(cb, 'Encountered duplicate signature in transaction');
		}
	}

	// Determine multisignatures from sender or transaction asset
	var multisignatures = sender.multisignatures || sender.u_multisignatures || [];
	if (multisignatures.length === 0) {
		if (trs.asset && trs.asset.multisignature && trs.asset.multisignature.keysgroup) {

			multisignatures = trs.asset.multisignature.keysgroup.map(function (key) {
				return key.slice(1);
			});
		}
	}

	// Add sender to multisignatures
	if (trs.requesterPublicKey) {
		multisignatures.push(trs.senderPublicKey);
	}

	// Verify multisignatures
	if (trs.signatures) {
		var verify;

		for (var d = 0; d < trs.signatures.length; d++) {
			verify = false;

			for (var s = 0; s < multisignatures.length; s++) {
				if (trs.requesterPublicKey && multisignatures[s] === trs.requesterPublicKey) {
					continue;
				}

				if (this.verifySignature(trs, multisignatures[s], trs.signatures[d])) {
					verify = true;
				}
			}

			if (!verify) {
				return setImmediate(cb, 'Failed to verify multisignature');
			}
		}
	}

	// Calculate fee
	var fee = __private.types[trs.type].calculateFee.call(this, trs, sender) || false;
	if (!fee || trs.fee !== fee) {
		return setImmediate(cb, 'Invalid transaction fee');
	}

	// Check amount
	if (trs.amount < 0 || trs.amount > constants.totalAmount || String(trs.amount).indexOf('.') >= 0 || trs.amount.toString().indexOf('e') >= 0) {
		return setImmediate(cb, 'Invalid transaction amount');
	}

	// Check timestamp
	if (slots.getSlotNumber(trs.timestamp) > slots.getSlotNumber()) {
		return setImmediate(cb, 'Invalid transaction timestamp');
	}

	// Call verify on transaction type
	__private.types[trs.type].verify.call(this, trs, sender, function (err) {
		return cb(err);
	});
};

Transaction.prototype.verifySignature = function (trs, publicKey, signature) {
	if (!__private.types[trs.type]) {
		throw Error('Unknown transaction type ' + trs.type);
	}

	if (!signature) { return false; }

	var res;

	try {
		var bytes = this.getBytes(trs, true, true);
		res = this.verifyBytes(bytes, publicKey, signature);
	} catch (e) {
		throw Error(e.toString());
	}

	return res;
};

Transaction.prototype.verifySecondSignature = function (trs, publicKey, signature) {
	if (!__private.types[trs.type]) {
		throw Error('Unknown transaction type ' + trs.type);
	}

	if (!signature) { return false; }

	var res;

	try {
		var bytes = this.getBytes(trs, false, true);
		res = this.verifyBytes(bytes, publicKey, signature);
	} catch (e) {
		throw Error(e.toString());
	}

	return res;
};

Transaction.prototype.verifyBytes = function (bytes, publicKey, signature) {
	var res;

	try {
		var data2 = new Buffer(bytes.length);

		for (var i = 0; i < data2.length; i++) {
			data2[i] = bytes[i];
		}

		var hash = crypto.createHash('sha256').update(data2).digest();
		var signatureBuffer = new Buffer(signature, 'hex');
		var publicKeyBuffer = new Buffer(publicKey, 'hex');

		res = ed.Verify(hash, signatureBuffer || ' ', publicKeyBuffer || ' ');
	} catch (e) {
		throw Error(e.toString());
	}

	return res;
};

Transaction.prototype.apply = function (trs, block, sender, cb) {
	if (!__private.types[trs.type]) {
		return setImmediate(cb, 'Unknown transaction type ' + trs.type);
	}

	if (!this.ready(trs, sender)) {
		return setImmediate(cb, 'Transaction is not ready');
	}

	var amount = bignum(trs.amount.toString()).plus(trs.fee.toString());
	var exceedsBalance = bignum(sender.balance.toString()).lessThan(amount);

	if (trs.blockId !== genesisblock.block.id && exceedsBalance) {
		return setImmediate(cb, 'Account has no LISK: ' + sender.address + ' balance=' + sender.balance);
	}

	amount = amount.toNumber();

	this.scope.account.merge(sender.address, {
		balance: -amount,
		blockId: block.id,
		round: calc(block.height)
	}, function (err, sender) {
		if (err) {
			return cb(err);
		}

		__private.types[trs.type].apply.call(this, trs, block, sender, function (err) {
			if (err) {
				this.scope.account.merge(sender.address, {
					balance: amount,
					blockId: block.id,
					round: calc(block.height)
				}, function (err) {
					return cb(err);
				});
			} else {
				return setImmediate(cb);
			}
		}.bind(this));
	}.bind(this));
};

Transaction.prototype.undo = function (trs, block, sender, cb) {
	if (!__private.types[trs.type]) {
		return setImmediate(cb, 'Unknown transaction type ' + trs.type);
	}

	var amount = trs.amount + trs.fee;

	this.scope.account.merge(sender.address, {
		balance: amount,
		blockId: block.id,
		round: calc(block.height)
	}, function (err, sender) {
		if (err) {
			return cb(err);
		}

		__private.types[trs.type].undo.call(this, trs, block, sender, function (err) {
			if (err) {
				this.scope.account.merge(sender.address, {
					balance: amount,
					blockId: block.id,
					round: calc(block.height)
				}, function (err) {
					return cb(err);
				});
			} else {
				return setImmediate(cb);
			}
		}.bind(this));
	}.bind(this));
};

Transaction.prototype.applyUnconfirmed = function (trs, sender, requester, cb) {
	if (typeof requester === 'function') {
		cb = requester;
	}

	if (!__private.types[trs.type]) {
		return setImmediate(cb, 'Unknown transaction type ' + trs.type);
	}

	if (!trs.requesterPublicKey && sender.secondSignature && !trs.signSignature && trs.blockId !== genesisblock.block.id) {
		return setImmediate(cb, 'Missing sender second signature');
	}

	if (!trs.requesterPublicKey && !sender.secondSignature && (trs.signSignature && trs.signSignature.length > 0)) {
		return setImmediate(cb, 'Sender does not have a second signature');
	}

	if (trs.requesterPublicKey && requester.secondSignature && !trs.signSignature) {
		return setImmediate(cb, 'Missing requester second signature');
	}

	if (trs.requesterPublicKey && !requester.secondSignature && (trs.signSignature && trs.signSignature.length > 0)) {
		return setImmediate(cb, 'Requester does not have a second signature');
	}

	var amount = bignum(trs.amount.toString()).plus(trs.fee.toString());
	var exceedsBalance = bignum(sender.u_balance.toString()).lessThan(amount);

	if (trs.blockId !== genesisblock.block.id && exceedsBalance) {
		return setImmediate(cb, 'Account has no LISK: ' + sender.address + ' balance=' + sender.u_balance);
	}

	amount = amount.toNumber();

	this.scope.account.merge(sender.address, {u_balance: -amount}, function (err, sender) {
		if (err) {
			return setImmediate(cb, err);
		}

		__private.types[trs.type].applyUnconfirmed.call(this, trs, sender, function (err) {
			if (err) {
				this.scope.account.merge(sender.address, {u_balance: amount}, function (err2) {
					return setImmediate(cb, err2 || err);
				});
			} else {
				return setImmediate(cb);
			}
		}.bind(this));
	}.bind(this));
};

Transaction.prototype.undoUnconfirmed = function (trs, sender, cb) {
	if (!__private.types[trs.type]) {
		return setImmediate(cb, 'Unknown transaction type ' + trs.type);
	}

	var amount = trs.amount + trs.fee;

	this.scope.account.merge(sender.address, {u_balance: amount}, function (err, sender) {
		if (err) {
			return setImmediate(cb, err);
		}

		__private.types[trs.type].undoUnconfirmed.call(this, trs, sender, function (err) {
			if (err) {
				this.scope.account.merge(sender.address, {u_balance: -amount}, function (err2) {
					return setImmediate(cb, err2 || err);
				});
			} else {
				return setImmediate(cb);
			}
		}.bind(this));
	}.bind(this));
};

Transaction.prototype.dbTable = 'trs';

Transaction.prototype.dbFields = [
	'id',
	'blockId',
	'type',
	'timestamp',
	'senderPublicKey',
	'requesterPublicKey',
	'senderId',
	'recipientId',
	'amount',
	'fee',
	'signature',
	'signSignature',
	'signatures'
];

Transaction.prototype.dbSave = function (trs) {
	if (!__private.types[trs.type]) {
		throw Error('Unknown transaction type ' + trs.type);
	}

	var senderPublicKey, signature, signSignature, requesterPublicKey;

	try {
		senderPublicKey = new Buffer(trs.senderPublicKey, 'hex');
		signature = new Buffer(trs.signature, 'hex');
		signSignature = trs.signSignature ? new Buffer(trs.signSignature, 'hex') : null;
		requesterPublicKey = trs.requesterPublicKey ? new Buffer(trs.requesterPublicKey, 'hex') : null;
	} catch (e) {
		throw Error(e.toString());
	}

	var promises = [
		{
			table: this.dbTable,
			fields: this.dbFields,
			values: {
				id: trs.id,
				blockId: trs.blockId,
				type: trs.type,
				timestamp: trs.timestamp,
				senderPublicKey: senderPublicKey,
				requesterPublicKey: requesterPublicKey,
				senderId: trs.senderId,
				recipientId: trs.recipientId || null,
				amount: trs.amount,
				fee: trs.fee,
				signature: signature,
				signSignature: signSignature,
				signatures: trs.signatures ? trs.signatures.join(',') : null,
			}
		}
	];

	var promise = __private.types[trs.type].dbSave(trs);

	if (promise) {
		promises.push(promise);
	}

	return promises;
};

Transaction.prototype.afterSave = function (trs, cb) {
	var tx_type = __private.types[trs.type];

	if (!tx_type) {
		return cb('Unknown transaction type ' + trs.type);
	} else {
		if (typeof tx_type.afterSave === 'function') {
			return tx_type.afterSave.call(this, trs, cb);
		} else {
			return cb();
		}
	}
};

Transaction.prototype.objectNormalize = function (trs) {
	if (!__private.types[trs.type]) {
		throw Error('Unknown transaction type ' + trs.type);
	}

	for (var i in trs) {
		if (trs[i] === null || typeof trs[i] === 'undefined') {
			delete trs[i];
		}
	}

	var report = this.scope.scheme.validate(trs, {
		type: 'object',
		properties: {
			id: {
				type: 'string'
			},
			height: {
				type: 'integer'
			},
			blockId: {
				type: 'string'
			},
			type: {
				type: 'integer'
			},
			timestamp: {
				type: 'integer'
			},
			senderPublicKey: {
				type: 'string',
				format: 'publicKey'
			},
			requesterPublicKey: {
				type: 'string',
				format: 'publicKey'
			},
			senderId: {
				type: 'string'
			},
			recipientId: {
				type: 'string'
			},
			amount: {
				type: 'integer',
				minimum: 0,
				maximum: constants.totalAmount
			},
			fee: {
				type: 'integer',
				minimum: 0,
				maximum: constants.totalAmount
			},
			signature: {
				type: 'string',
				format: 'signature'
			},
			signSignature: {
				type: 'string',
				format: 'signature'
			},
			asset: {
				type: 'object'
			}
		},
		required: ['type', 'timestamp', 'senderPublicKey', 'signature']
	});

	if (!report) {
		throw Error('Failed to normalize transaction: ' + this.scope.scheme.getLastError());
	}

	try {
		trs = __private.types[trs.type].objectNormalize.call(this, trs);
	} catch (e) {
		throw Error(e.toString());
	}

	return trs;
};

Transaction.prototype.dbRead = function (raw) {
	if (!raw.t_id) {
		return null;
	} else {
		var tx = {
			id: raw.t_id,
			height: raw.b_height,
			blockId: raw.b_id || raw.t_blockId,
			type: parseInt(raw.t_type),
			timestamp: parseInt(raw.t_timestamp),
			senderPublicKey: raw.t_senderPublicKey,
			requesterPublicKey: raw.t_requesterPublicKey,
			senderId: raw.t_senderId,
			recipientId: raw.t_recipientId,
			amount: parseInt(raw.t_amount),
			fee: parseInt(raw.t_fee),
			signature: raw.t_signature,
			signSignature: raw.t_signSignature,
			signatures: raw.t_signatures ? raw.t_signatures.split(',') : [],
			confirmations: parseInt(raw.confirmations),
			asset: {}
		};

		if (!__private.types[tx.type]) {
			throw Error('Unknown transaction type ' + tx.type);
		}

		var asset = __private.types[tx.type].dbRead.call(this, raw);

		if (asset) {
			tx.asset = extend(tx.asset, asset);
		}

		return tx;
	}
};

// Export
module.exports = Transaction;
