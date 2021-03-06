var _ = require('underscore')
var async = require('async')
var Battle = require('./battle')
var Bot = require('./bot')
var Challenge = require('./challenge')
var Contest = require('./contest')
var Games = require('./games')
var express = require('express')
var kue = require('kue')
var moment = require('moment')
var passport = require('passport')
var Party = require('./party')
var postmark = require('postmark')
var validator = require('validator')
var vm = require('vm')

queue = kue.createQueue({
	jobEvents: false
})

module.exports = exports = r = new express.Router()

r.use(function(req, res, next) {
	if(req.user && (req.user.lastSeen === null || moment().add(-6, 'hours').isAfter(req.user.lastSeen))) {
		req.user.lastSeen = moment().toDate()
		req.user.save(function(err) {
			if(err) {
				return next(err)
			}

			next()
		})
	}

	next()
})

r.route('/my-bots')
.all(requireLogin())
.get(countNewChallenges())
.get(function(req, res, next) {
	async.auto({
		bots: function(done) {
			Bot.findByAuthor(req.user, done)
		},

		nextContest: function(done) {
			Contest.findOne()
			.where('deadline').gt(new Date())
			.sort('deadline')
			.exec(done)
		},

		nextParty: ['nextContest', function(done, ctx) {
			Party.findOne()
			.where('contest', ctx.nextContest)
			.where('user', req.user)
			.populate('bot')
			.exec(done)
		}]

	}, function(err, ctx) {
		if(err) {
			return next(err)
		}

		res.render('my-bots', {
			user: req.user,
			bots: ctx.bots,
			nextContest: ctx.nextContest,
			nextParty: ctx.nextParty
		})
	})
})

r.route('/my-bots/new')
.all(requireLogin())
.all(function(req, res, next) {
	Bot.count({
		author: req.user
	}, function(err, count) {
		if(err) {
			return next(err)
		}

		if(count >= process.env.OPT_MAX_BOTS_PER_USER) {
			req.flash('warning', 'You may not create more than '+process.env.OPT_MAX_BOTS_PER_USER+' bots')
			return res.redirect('back')
		}

		next()
	})
})
.get(countNewChallenges())
.get(function(req, res, next) {
	res.render('bot-new', {
		user: req.user,
		games: process.env.OPT_GAMES.split(',')
	})
})
.post(gaugeRate('saves'))
.post(function(req, res, next) {
	if(req.limit.count > process.env.OPT_MAX_SAVES_PER_HOUR) {
		req.flash('warning', 'You may save bots at most '+process.env.OPT_MAX_SAVES_PER_HOUR+' times every hour')
		return res.redirect('back')
	}

	var games = process.env.OPT_GAMES.split(',')
	if(!req.body.game) {
		req.body.game = games[0]
	}

	switch(true) {
		case !validator.isLength(req.body.name, 1, 32):
			req.flash('warning', 'Name should be between 1 and 32 characters long')
			return res.redirect('back')

		case !_.contains(games, req.body.game):
			req.flash('warning', 'Invalid game type')
			return res.redirect('back')
	}

	var bot = new Bot()
	bot.author = req.user
	bot.name = req.body.name
	bot.code = req.body.code
	bot.game = req.body.game

	var issue = bot.verifyCode()
	if(issue) {
		req.flash('warning', 'Code validation failed: '+issue.error)
		return res.redirect('back')
	}

	bot.save(function(err) {
		if(err) {
			return next(err)
		}

		res.redirect('/my-bots')
	})
})

r.route('/bots/:id')
.all(requireLogin())
.get(function(req, res, next) {
	Bot.findById(req.params.id, function(err, bot) {
		if(err) {
			return next(err)
		}
		if(!bot) {
			return res.send(404)
		}
		if(bot.author.toString() !== req.user.id.toString() && req.user.roles.indexOf('admin') === -1) {
			return res.send(401)
		}

		req.bot = bot
		next()
	})
})
.get(countNewChallenges())
.get(function(req, res, next) {
	Bot.findByAuthor(req.user, function(err, bots) {
		if(err) {
			return next(err)
		}

		res.render('bot-view', {
			user: req.user,
			bot: req.bot,
			bots: bots
		})
	})
})

r.route('/bots/:id/edit')
.all(requireLogin())
.all(function(req, res, next) {
	Bot.findById(req.params.id, function(err, bot) {
		if(err) {
			return next(err)
		}
		if(!bot) {
			return res.send(404)
		}
		if(bot.author.toString() !== req.user.id.toString() && req.user.roles.indexOf('admin') === -1) {
			return res.send(401)
		}

		req.bot = bot
		next()
	})
})
.all(function(req, res, next) {
	Party.count()
	.where('bot', req.bot)
	.exec(function(err, count) {
		if(err) {
			return next(err)
		}

		if(count > 0) {
			req.flash('warning', 'You cannot modify a bot enrolled in a contest')
			return res.redirect('back')
		}

		next()
	})
})
.get(countNewChallenges())
.get(function(req, res, next) {
	res.render('bot-edit', {
		user: req.user,
		bot: req.bot
	})
})
.post(gaugeRate('saves'))
.post(function(req, res, next) {
	if(req.limit.count > process.env.OPT_MAX_SAVES_PER_HOUR) {
		req.flash('warning', 'You may save bots at most '+process.env.OPT_MAX_SAVES_PER_HOUR+' times every hour')
		return res.redirect('back')
	}

	switch(true) {
		case !validator.isLength(req.body.name, 1, 32):
			req.flash('warning', 'Name should be between 1 and 32 characters long')
			return res.redirect('back')
	}

	var bot = req.bot
	bot.name = req.body.name
	bot.code = req.body.code

	var issue = bot.verifyCode()
	if(issue) {
		req.flash('warning', 'Code validation failed: '+issue.error)
		return res.redirect('back')
	}

	bot.save(function(err) {
		if(err) {
			return next(err)
		}

		res.redirect('/my-bots')
	})
})

// r.route('/bots/:id/delete')
// .all(requireLogin())
// .all(function(req, res, next) {
// 	Bot.findById(req.params.id, function(err, bot) {
// 		if(err) {
// 			return next(err)
// 		}
// 		if(!bot) {
// 			return res.send(404)
// 		}
// 		if(bot.author.toString() !== req.user.id.toString() && req.user.roles.indexOf('admin') === -1) {
// 			return res.send(401)
// 		}

// 		req.bot = bot
// 		next()
// 	})
// })
// .post(function(req, res, next) {
// 	Party.count()
// 	.where('bot', req.bot)
// 	.exec(function(err, count) {
// 		if(err) {
// 			return next(err)
// 		}

// 		if(count > 0) {
// 			req.flash('warning', 'You cannot remove a bot enrolled in a contest')
// 			return res.redirect('back')
// 		}

// 		req.bot.remove(function(err) {
// 			if(err) {
// 				return next(err)
// 			}

// 			res.redirect('/my-bots')
// 		})
// 	})
// })

r.route('/my-battles')
.all(requireLogin())
.get(countNewChallenges())
.get(function(req, res, next) {
	Party.find()
	.where('user', req.user)
	.populate('contest')
	.populate('result.rounds.battles')
	.sort('-created')
	.exec(function(err, parties) {
		if(err) {
			return next(err)
		}

		async.each(parties, function(party, done) {
			async.each(party.result.rounds, function(round, done) {
				async.each(round.battles, function(battle, done) {
					battle.populate('parties.user parties.bot', done)
				}, done)
			}, done)
		}, function(err) {
			if(err) {
				return next(err)
			}

			res.render('my-battles', {
				user: req.user,
				parties: parties
			})
		})
	})
})

r.route('/test-battle')
.all(requireLogin())
.get(countNewChallenges())
.get(function(req, res, next) {
	Battle.findOne()
	.where('rel.trackId', req.query.trackId || '')
	.exec(function(err, battle) {
		if(err) {
			return next(err)
		}
		if(!battle) {
			return res.send(404)
		}

		res.json({
			next: '/battles/'+battle.id.toString()
		})
	})
})
.post(gaugeRate('tests'))
.post(function(req, res, next) {
	if(req.limit.count > process.env.OPT_MAX_TESTS_PER_HOUR) {
		req.flash('warning', 'You may run at most '+process.env.OPT_MAX_TESTS_PER_HOUR+' test battles every hour')
		return res.redirect('back')
	}

	var battle = new Battle({
		expiry: moment().add(4, 'days').toDate()
	})
	battle.save(function(err) {
		if(err) {
			return next(err)
		}

		async.map([
			req.body.bot,
			req.body.other

		], function(id, done) {
			Bot.findById(id)
			.populate('author')
			.exec(done)

		}, function(err, bots) {
			if(err) {
				return next(err)
			}
			for(var i = 0; i < 2; ++i) {
				var bot = bots[i]
				if(!bot || !req.user.isAdmin && bot.author.id.toString() !== req.user.id.toString()) {
					return res.send(401)
				}
			}

			res.redirect('/battles/' + battle.id.toString())

			function emit(data) {
				data.no = ++emit.no
				req.io.to('battle-run:'+battle.id).emit('battle-run:step', data)
			}
			emit.no = 0

			queue.create('battle', {
				bots: [
					bots[0].id.toString(),
					bots[1].id.toString()
				],
				battle: battle.id.toString(),
				game: bots[0].game
			})
			.removeOnComplete(true)
			.ttl(60000)
			.attempts(4)
			.save()
		})
	})
})

r.route('/my-challenges')
.all(requireLogin())
.get(countNewChallenges())
.get(function(req, res, next) {
	async.auto({
		newChallenges: function(done) {
			Challenge.find()
			.where('parties.user', req.user)
			.where('battle').exists(false)
			.populate('parties.user parties.bot battle')
			.exec(done)
		},

		challenges: function(done) {
			Challenge.find()
			.where('parties.user', req.user)
			.where('battle').exists(true)
			.populate('parties.user parties.bot battle')
			.exec(done)
		}

	}, function(err, ctx) {
		if(err) {
			return next(err)
		}

		res.render('my-challenges', {
			user: req.user,
			newChallenges: ctx.newChallenges,
			challenges: ctx.challenges
		})
	})
})

r.route('/my-challenges/new')
.all(requireLogin())
.get(countNewChallenges())
.get(function(req, res, next) {
	async.auto({
		bots: function(done) {
			Bot.findByAuthor(req.user, done)
		}

	}, function(err, ctx) {
		if(err) {
			return next(err)
		}

		res.render('challenge-new', {
			user: req.user,
			bots: ctx.bots
		})
	})
})
.post(gaugeRate('challenges'))
.post(function(req, res, next) {
	if(req.limit.count > process.env.OPT_MAX_CHALLENGES_PER_HOUR) {
		req.flash('warning', 'You may create at most '+process.env.OPT_MAX_CHALLENGES_PER_HOUR+' challenges every hour')
		return res.redirect('back')
	}

	req.body.message = req.body.message.trim()
	if(req.body.message.length > 256) {
		req.flash('warning', 'Message too long')
		return res.redirect('back')
	}

	if(req.body.opponent.length > 256) {
		req.flash('warning', 'Opponent name too long')
		return res.redirect('back')
	}

	async.auto({
		myBot: function(done) {
			Bot.findById(req.body.bot)
			.populate('author')
			.exec(function(err, bot) {
				if(err) {
					return next(err)
				}
				if(!bot || bot.author.id.toString() !== req.user.id.toString()) {
					res.send(400)
					return done(true)
				}

				done(null, bot)
			})
		},

		other: function(done) {
			switch(true) {
				case !!req.body.opponent.match(/^.+@.+$/):
					User.findByEmail(req.body.opponent, function(err, user) {
						if(err) {
							return next(err)
						}
						if(!user || user.id.toString() === req.user.id.toString()) {
							return done(null, {
								stub: true,
								name: req.body.opponent
							})
						}

						done(null, user)
					})
					break

				case !!req.body.opponent.match(/^@.+$/):
					User.findByTwitterUsername(req.body.opponent, function(err, user) {
						if(err) {
							return next(err)
						}
						if(!user || user.id.toString() === req.user.id.toString()) {
							req.flash('warning', 'Invalid opponent')
							res.redirect('back')
							return done(true)
						}

						done(null, user)
					})
					break

				default:
					req.flash('warning', 'Invalid opponent')
					res.redirect('back')
					return done(true)
			}
		},

		prevChallenge: ['other', function(done, ctx) {
			Challenge.findOne()
			.where('parties.0.user', req.user)
			.where(!ctx.other.stub ? {
				'parties.1.user': ctx.other
			} : {
				'parties.1.stub.name': ctx.other.name
			})
			.where('battle').exists(false)
			.exec(function(err, challenge) {
				if(err) {
					return done(err)
				}
				if(challenge) {
					req.flash('warning', 'You have already challenged '+ctx.other.name)
					res.redirect('/challenges/'+challenge.id.toString())
					return done(true)
				}

				done(null)
			})
		}],

		challenge: ['myBot', 'other', 'prevChallenge', function(done, ctx) {
			var challenge = new Challenge()
			challenge.parties = [
				{
					user: req.user,
					bot: ctx.myBot
				},
				!ctx.other.stub ? {
					user: ctx.other
				} : {
					stub: ctx.other
				}
			]
			challenge.game = ctx.myBot.game
			challenge.message = req.body.message

			challenge.save(function(err) {
				if(err) {
					return done(err)
				}

				done(null, challenge)
			})
		}],

		email: ['challenge', 'other', function(done, ctx) {
			if(!ctx.other.stub || ctx.other.name.match(/^@.+$/)) {
				return done()
			}

			msg = ''
			msg += 'Hey there!\n\n'
			msg += req.user.name + ' challenged you to a game of Battlescripts.\n\n'
			if(req.body.message.length > 0) {
				msg += '    ' + req.body.message.replace(/\s+/gm, ' ') + '\n\n'
			}
			msg += 'Battlescripts is where you write bots in JavaScript, challenge your friends\' bots, and earn glory!\n\n'
			msg += 'Click on the following link to learn more:\n'
			msg += process.env.BASE + '/?t=' + new Buffer(ctx.challenge.parties[1].stub.hash).toString('base64') + '\n\n'
			msg += 'Toptal'

			if(!process.env.POSTMARK_API_KEY) {
				console.log('Pretending to send email to '+ctx.other.name+'\n\n'+msg)
				return done()
			}
			new postmark.Client(process.env.POSTMARK_API_KEY).sendEmail({
				From: 'id@battlescripts.toptal.net',
				To: ctx.other.name,
				Subject: 'Battlescripts Challenge from '+req.user.name,
				TextBody: msg
			}, function(err) {
				if(err) {
					console.log('Unable to send email via Postmark: ' + err.message)
				}
				done()
			})
		}]

	}, function(err, ctx) {
		if(err) {
			if(res.headersSent) {
				return
			}
			return next(err)
		}

		req.flash('info', 'Challenge created')
		res.redirect('/my-challenges')
	})
})

r.route('/challenges/:id')
.all(requireLogin())
.get(countNewChallenges())
.get(function(req, res, next) {
	Challenge.findById(req.params.id)
	.populate('parties.user parties.bot battle')
	.exec(function(err, challenge) {
		if(err) {
			return next(err)
		}

		Bot.findByAuthor(req.user)
		.where('game', challenge.game)
		.exec(function(err, bots) {
			if(err) {
				return next(err)
			}

			res.render('challenge-view', {
				user: req.user,
				challenge: challenge,
				bots: bots
			})
		})
	})
})

r.route('/challenges/:id/respond')
.all(requireLogin())
.all(function(req, res, next) {
	Challenge.findById(req.params.id)
	.populate('parties.user parties.bot battle')
	.exec(function(err, challenge) {
		if(err) {
			return next(err)
		}
		if(!challenge) {
			return res.send(404)
		}

		req.challenge = challenge
		next()
	})
})
.all(countNewChallenges())
.post(function(req, res, next) {
	if(!req.challenge.isParty(req.user) || req.challenge.parties[1].user.id.toString() !== req.user.id.toString()) {
		return res.send(403)
	}

	if(req.challenge.battle) {
		return res.redirect('/battles/'+req.challenge.battle.id.toString())
	}

	Bot.findById(req.body.bot)
	.populate('author')
	.exec(function(err, bot) {
		if(err) {
			return next(err)
		}
		if(!bot || bot.author.id.toString() !== req.user.id.toString()) {
			return res.send(400)
		}

		var battle = new Battle()
		battle.save(function(err) {
			if(err) {
				return next(err)
			}

			req.challenge.parties[1].bot = bot
			req.challenge.battle = battle
			req.challenge.save(function(err) {
				if(err) {
					return next(err)
				}

				res.redirect('/battles/'+battle.id)

				function emit(data) {
					data.no = ++emit.no
					req.io.to('battle-run:'+battle.id).emit('battle-run:step', data)
				}
				emit.no = 0

				queue.create('battle', {
					bots: [
						req.challenge.parties[0].bot.id.toString(),
						bot.id.toString()
					],
					battle: battle.id.toString(),
					game: req.challenge.game
				})
				.removeOnComplete(true)
				.ttl(60000)
				.attempts(4)
				.save()
			})
		})
	})
})

r.route('/users')
.all(requireLogin())
.all(requireRole('admin'))
.get(countNewChallenges())
.get(function(req, res, next) {
	User.find(function(err, users) {
		if(err) {
			return next(err)
		}

		res.render('users', {
			user: req.user,
			users: users
		})
	})
})

r.route('/users/search')
.all(requireLogin())
.all(requireRole('admin'))
.get(countNewChallenges())
.get(function(req, res, next) {
	if(!req.query.q) {
		return res.redirect('/users')
	}

	User.find({
		words: req.query.q

	}, function(err, users) {
		if(err) {
			return next(err)
		}

		res.render('user-serp', {
			user: req.user,
			users: users,
			q: req.query.q
		})
	})
})

r.route('/users/:id')
.all(requireLogin())
.all(requireRole('admin'))
.get(countNewChallenges())
.get(function(req, res, next) {
	async.auto({
		user: function(done) {
			User.findById(req.params.id, done)
		},

		parties: ['user', function(done, ctx) {
			Party.find()
			.where('user', ctx.user)
			.populate('contest')
			.exec(done)
		}],

		bots: ['user', function(done, ctx) {
			Bot.findByAuthor(ctx.user, done)
		}]

	}, function(err, ctx) {
		if(err) {
			return next(err)
		}

		res.render('user-view', {
			user: req.user,
			other: ctx.user,
			parties: ctx.parties,
			bots: ctx.bots
		})
	})
})

r.route('/users/:id/pretend')
.all(requireLogin())
.all(requireRole('admin'))
.get(countNewChallenges())
.post(function(req, res, next) {
	User.findById(req.params.id, function(err, user) {
		if(err) {
			return next(err)
		}
		if(!user) {
			return res.send(404)
		}

		req.logout()
		req.login(user, function(err) {
			if(err) {
				return next(err)
			}

			res.redirect('/')
		})
	})
})

r.route('/contests')
.all(requireLogin())
.all(requireRole('admin'))
.get(countNewChallenges())
.get(function(req, res, next) {
	Contest.find(function(err, contests) {
		if(err) {
			return next(err)
		}

		res.render('contests', {
			user: req.user,
			contests: contests
		})
	})
})

r.route('/contests/new')
.all(requireLogin())
.all(requireRole('admin'))
.get(countNewChallenges())
.get(function(req, res, next) {
	res.render('contest-new', {
		user: req.user
	})
})
.post(function(req, res, next) {
	var contest = new Contest()
	contest.title = req.body.title
	contest.deadline = req.body.deadline
	contest.save(function(err) {
		if(err) {
			return next(err)
		}

		req.flash('info', 'Contest created')
		res.redirect('/contests')
	})
})

r.route('/contests/:id')
.all(requireLogin())
.all(requireRole('admin'))
.get(countNewChallenges())
.get(function(req, res, next) {
	async.auto({
		contest: function(done) {
			Contest.findById(req.params.id, done)
		},

		partyCount: ['contest', function(done, ctx) {
			Party.count({
				contest: ctx.contest
			}, done)
		}],

		battleCount: ['contest', function(done, ctx) {
			Battle.count()
			.where('rel.contest', ctx.contest)
			.exec(done)
		}]

	}, function(err, ctx) {
		if(err) {
			return next(err)
		}

		res.render('contest-view', {
			user: req.user,
			contest: ctx.contest,
			partyCount: ctx.partyCount,
			battleCount: ctx.battleCount
		})
	})
})

r.route('/contests/:id/edit')
.all(requireLogin())
.all(requireRole('admin'))
.all(fetchContest({
	required: true
}))
.get(countNewChallenges())
.get(function(req, res, next) {
	res.render('contest-edit', {
		user: req.user,
		contest: req.contest
	})
})
.post(function(req, res, next) {
	req.contest.title = req.body.title
	req.contest.deadline = req.body.deadline
	req.contest.save(function(err) {
		if(err) {
			return next(err)
		}

		req.flash('info', 'Contest updated')
		res.redirect('/contests')
	})
})

r.route('/contests/:id/participate')
.all(requireLogin())
.all(fetchContest({
	required: true
}))
.post(function(req, res, next) {
	Bot.findById(req.body.bot)
	.populate('author')
	.exec(function(err, bot) {
		if(err) {
			return next(err)
		}
		if(!bot || bot.author.id.toString() !== req.user.id.toString()) {
			return res.send(400)
		}

		if(req.body._action === 'unenroll') {
			Party.remove()
			.where('contest', req.contest)
			.where('user', req.user)
			.exec(function(err) {
				if(err) {
					return next(err)
				}

				req.flash('info', 'Your bot has been unenrolled from the contest')
				res.redirect('back')
			})
			return
		}

		var party = new Party()
		party.contest = req.contest
		party.user = req.user
		party.bot = bot
		party.approved = null
		Party.findOneAndUpdate({
			contest: req.contest,
			user: req.user
		}, _.omit(party.toObject(), [
			'_id'
		]), {
			upsert: true
		}, function(err) {
			if(err) {
				return next(err)
			}

			res.redirect('back')
		})
	})
})

r.route('/contests/:id/participants')
.all(requireLogin())
.all(requireRole('admin'))
.all(fetchContest({
	required: true
}))
.get(countNewChallenges())
.get(function(req, res, next) {
	Party.find()
	.where('contest', req.contest)
	.populate('user')
	.populate('bot')
	.exec(function(err, parties) {
		if(err) {
			return next(err)
		}

		res.render('parties', {
			user: req.user,
			parties: parties
		})
	})
})

r.route('/contests/:id/commence')
.all(requireLogin())
.all(requireRole('admin'))
.all(fetchContest({
	required: true
}))
.post(function(req, res, next) {
	if(req.contest.published) {
		req.flash('warning', 'Contest results has already been published')
		return res.redirect('back')
	}

	res.render('contest-run', {
		user: req.user,
		contest: req.contest
	})

	var start = moment()

	function emit(data) {
		data.no = ++emit.no
		req.io.to('contest-run:'+req.contest.id).emit('contest-run:step', data)
	}
	emit.no = 0

	async.series([
		function(done) {
			emit({
				kind: 'purge',
				line: 'Purging old battle data'
			})

			Battle.remove()
			.where('rel.contest', req.contest)
			.exec(function(err) {
				if(err) {
					return done(err)
				}

				emit({
					kind: 'purge-done',
					line: '.. done'
				})
				done()
			})
		},

		function(done) {
			var rounds = _.flatten([
				{
					no: 0,

					partyQ: function() {
						return Party.find()
						.where('contest', req.contest)
						.populate('bot')
						.populate('user')
					},

					otherQ: function() {
						return this.partyQ()
						.sort('random')
					}
				},

				[128, 64, 32, 16, 8, 4, 2].map(function(size, i) {
					return {
						no: i + 1,

						partyQ: function() {
							return Party.find()
							.where('contest', req.contest)
							.populate('bot')
							.populate('user')
							.sort('-result.rounds.'+(this.no-1)+'.points')
							.limit(size)
						},

						otherQ: function() {
							return this.partyQ()
							.where('result.rounds.'+this.no+'.events', 0)
							.sort('result.rounds.'+(this.no-1)+'.points')
						}
					}
				})
			])

			async.eachSeries(rounds, function(round, done) {
				emit({
					kind: 'round',
					line: 'Starting round '+(round.no+1)
				})

				async.series([
					function(done) {
						round.partyQ()
						.stream()
						.on('data', function(party) {
							this.pause()

							if(round.no === 0) {
								party.result.rounds = []
							}
							party.result.rounds.push({
								no: round.no,
								battles: [],
								points: 0,
								events: 0
							})
							party.save(function(err) {
								if(err) {
									return done(err)
								}

								this.resume()
							}.bind(this))
						})
						.on('end', function() {
							done()
						})
					},

					function(done) {
						round.partyQ()
						.stream()
						.on('data', function(party) {
							this.pause()

							round.otherQ()
							.exec(function(err, others) {
								if(err) {
									return done(err)
								}

								async.eachSeries(others, function(other, done) {
									if(other.id.toString() === party.id.toString()) {
										return done()
									}
									if(party.result.rounds[round.no].battles.length === 64) {
										return done()
									}

									var parties = [
										party,
										other
									]

									emit({
										kind: 'battle',
										line: 'Starting battle between '+party.bot.name+' vs '+other.bot.name
									})

									var engine = new Games[(process.env.OPT_DEBUG_GAME || 'Battleships')](party.bot.codeObj, other.bot.codeObj)
									engine.play(function(err) {
										if(err) {
											return done(err)
										}

										var battle = new Battle()
										battle.rel.contest = req.contest
										battle.rel.roundNo = round.no
										parties.forEach(function(party, i) {
											battle.parties.push({
												user: party.bot.author,
												bot: party.bot,
												code: party.bot.code,
												pieces: engine.pieces[i],
												grid: engine.grids[i],
												winner: engine.winner.botNo === i
											})
											party.result.rounds[round.no].points += engine.winner.botNo === i ? 1 : 0
											party.result.rounds[round.no].events += 1
										})
										battle.moves = engine.moves
										battle.ended = new Date()
										battle.save(function(err) {
											if(err) {
												return done(err)
											}

											async.each(parties, function(party, done) {
												party.result.rounds[round.no].battles.push(battle)
												party.save(done)

											}, function(err) {
												if(err) {
													return done(err)
												}

												emit({
													kind: 'battle-done',
													line: '.. done'
												})
												done()
											})
										})
									})
								}, function() {
									this.resume()
								}.bind(this))
							}.bind(this))
						})
						.on('end', function() {
							done()
						})
					}

				], function(err) {
					if(err) {
						return done(err)
					}

					emit({
						kind: 'round-done'
					})
					done()
				})
			}, done)
		}

	], function(err) {
		if(err) {
			return next(err)
		}

		emit({
			kind: 'finish',
			line: 'Contest run finished (took '+moment().diff(start, 'seconds')+'s)'
		})
	})
})

r.route('/contests/:id/publish')
.all(requireLogin())
.all(requireRole('admin'))
.all(fetchContest({
	required: true
}))
.post(function(req, res, next) {
	req.contest.published = new Date()
	req.contest.save(function(err) {
		if(err) {
			return next(err)
		}

		res.redirect('back')
	})
})

r.route('/contests/:id/unpublish')
.all(requireLogin())
.all(requireRole('admin'))
.all(fetchContest({
	required: true
}))
.post(function(req, res, next) {
	req.contest.published = null
	req.contest.save(function(err) {
		if(err) {
			return next(err)
		}

		res.redirect('back')
	})
})

r.route('/contests/:id/battles')
.all(requireLogin())
.all(fetchContest({
	required: true
}))
.get(countNewChallenges())
.get(function(req, res, next) {
	Battle.find()
	.where('rel.contest', req.contest)
	.populate('parties.user')
	.populate('parties.bot')
	.populate({ path: 'parties.bot.author', model: 'User' })
	.exec(function(err, battles) {
		if(err) {
			return next(err)
		}

		res.render('battles', {
			user: req.user,
			contest: req.contest,
			battles: battles
		})
	})
})

r.route('/participants/:id')
.all(requireLogin())
.all(requireRole('admin'))
.all(fetchParty({
	required: true
}))
.get(countNewChallenges())
.get(function(req, res, next) {
	req.party.populate('result.rounds.battles', function(err) {
		if(err) {
			return next(err)
		}

		async.each(req.party.result.rounds, function(round, done) {
			async.each(round.battles, function(battle, done) {
				battle.populate('parties.user parties.bot', done)
			}, done)
		}, function(err) {
			if(err) {
				return next(err)
			}

			res.render('party-view', {
				user: req.user,
				party: req.party
			})
		})
	})
})

r.route('/participants/:id/approve')
.all(requireLogin())
.all(requireRole('admin'))
.all(fetchParty({
	required: true
}))
.post(function(req, res, next) {
	req.party.approved = new Date()
	req.party.save(function(err) {
		if(err) {
			return next(err)
		}

		res.redirect('back')
	})
})

r.route('/participants/:id/unapprove')
.all(requireLogin())
.all(requireRole('admin'))
.all(fetchParty({
	required: true
}))
.post(function(req, res, next) {
	req.party.approved = null
	req.party.save(function(err) {
		if(err) {
			return next(err)
		}

		res.redirect('back')
	})
})

r.route('/participants/:id/reject')
.all(requireLogin())
.all(requireRole('admin'))
.all(fetchParty({
	required: true
}))
.post(function(req, res, next) {
	req.party.remove(function(err) {
		if(err) {
			return next(err)
		}

		res.redirect('/contests/'+req.party.contest.toString()+'/participants')
	})
})

r.route('/battles/:id.json')
.all(requireLogin())
.get(function(req, res, next) {
	Battle.findById(req.params.id)
	.populate('parties.user')
	.populate('parties.bot')
	.populate({ path: 'parties.bot.author', model: 'User' })
	.exec(function(err, battle) {
		if(err) {
			return next(err)
		}
		if(!battle) {
			return res.send(404)
		}

		if(!battle.ended) {
			return res.send(204)
		}

		res.setHeader('Content-Type', 'application/json')
		res.setHeader('Content-Disposition', 'attachment; filename=battle-'+battle.id.toString()+'.json')
		res.send(200, JSON.stringify({
			parties: _.map(battle.parties, function(party) {
				return {
					user: {
						name: party.user.name
					},
					bot: {
						name: party.bot.name
					},
					code: party.code,
					pieces: _.map(party.pieces, function(piece) {
						return _.omit(piece.toJSON(), '_id')
					}),
					grid: party.grid,
					winner: party.winner
				}
			}),
			moves: _.map(battle.moves, function(move) {
				return _.omit(move.toJSON(), '_id')
			})
		}, null, 4))
	})
})

r.route('/battles/:id')
.all(requireLogin())
.get(countNewChallenges())
.get(function(req, res, next) {
	async.auto({
		battle: function(done) {
			Battle.findById(req.params.id)
			.populate('parties.user')
			.populate('parties.bot')
			.populate({ path: 'parties.bot.author', model: 'User' })
			.exec(function(err, battle) {
				if(err) {
					return done(err)
				}
				if(!battle) {
					res.send(404)
					return done(true)
				}

				if(!battle.ended) {
					res.render('battle-wait', {
						user: req.user,
						battle: battle
					})
					return done(true)
				}

				done(null, battle)
			})
		},

		otherBots: ['battle', function(done, ctx) {
			if(ctx.battle.parties[0].user.id.toString() === ctx.battle.parties[1].user.id.toString()) {
				return done(null, [])
			}

			ctx.battle.parties.forEach(function(party, i) {
				if(party.user.id.toString() === req.user.id.toString()) {
					Bot.find()
					.where('stats.wins').gt(0)
					.where('score', party.winner ? { $gte: party.bot.score } : { $lte: party.bot.score })
					.where('author').ne(req.user)
					.sort({
						score: party.winner ? 1 : -1
					})
					.limit(5)
					.populate('author')
					.exec(done)
				}
			})
		}]

	}, function(err, ctx) {
		if(err) {
			if(err === true) {
				return
			}
			return next(err)
		}

		res.render('battle-view-'+ctx.battle.game.toLowerCase(), {
			user: req.user,
			battle: ctx.battle,
			otherBots: ctx.otherBots
		})
	})
})

r.route('/battles/:id/ended.json')
.all(requireLogin())
.get(function(req, res, next) {
	Battle.findById(req.params.id, function(err, battle) {
		if(err) {
			return next(err)
		}

		res.json(battle.ended)
	})
})

r.route('/battles/:id/status.json')
.all(requireLogin())
.get(function(req, res, next) {
	Battle.findById(req.params.id, function(err, battle) {
		if(err) {
			return next(err)
		}

		switch(true) {
			case !!battle.ended:
				return res.json('ended')

			case !!battle.started:
				return res.json('started')

			default:
				return res.json('')
		}
	})
})

r.route('/leaderboard')
.all(requireLogin())
.get(countNewChallenges())
.get(function(req, res, next) {
	Bot.find()
	.where('stats.wins').gt(0)
	.sort({
		score: -1
	})
	.limit(100)
	.populate('author')
	.exec(function(err, bots) {
		if(err) {
			return next(err)
		}

		var invite = false
		for(var i = 0; i < bots.length && i < 10; ++i) {
			if(bots[i].author.id.toString() === req.user.id.toString()) {
				invite = true
				break
			}
		}

		res.render('leaderboard', {
			user: req.user,
			bots: bots,
			invite: invite
		})
	})
})

r.route('/login')
.get(function(req, res, next) {
	res.render('login')
})

r.route('/logout')
.get(function(req, res, next) {
	req.logout()
	delete req.session.t
	res.redirect('/')
})

r.route('/')
.get(function(req, res, next) {
	if(!req.user) {
		if(req.query.t) {
			req.session.t = req.query.t
		}
		return res.redirect('/login')
	}

	res.redirect('/my-bots')
})

r.route('/auth/twitter')
.get(passport.authenticate('twitter'))

r.route('/auth/twitter/callback')
.get(function(req, res, next) {
	passport.authenticate('twitter', {}, function(err, user) {
		if(err) {
			return next(err)
		}

		if(!user) {
			return res.redirect('/login')
		}

		req.login(user, function(err) {
			if(err) {
				return next(err)
			}

			req.flash('info', 'Hello, '+user.name+'!')
			res.redirect('/')
		})
	})(req, res, next)
})

r.route('/auth/facebook')
.get(passport.authenticate('facebook', {
	scope: ['email']
}))

r.route('/auth/facebook/callback')
.get(function(req, res, next) {
	passport.authenticate('facebook', {}, function(err, user, info) {
		if(err) {
			return next(err)
		}

		if(!user) {
			if(info && info.msg) {
				req.flash('warning', info.msg)
			}
			return res.redirect('/login')
		}

		req.login(user, function(err) {
			if(err) {
				return next(err)
			}

			req.flash('info', 'Hello, '+user.name+'!')
			res.redirect('/')
		})
	})(req, res, next)
})

r.route('/auth/google')
.get(passport.authenticate('google', {
	scope: [
		'https://www.googleapis.com/auth/plus.login',
		'https://www.googleapis.com/auth/plus.profile.emails.read'
	]
}))

r.route('/auth/google/callback')
.get(function(req, res, next) {
	passport.authenticate('google', {}, function(err, user, info) {
		if(err) {
			return next(err)
		}

		if(!user) {
			if(info && info.msg) {
				req.flash('warning', info.msg)
			}
			return res.redirect('/login')
		}

		req.login(user, function(err) {
			if(err) {
				return next(err)
			}

			req.flash('info', 'Hello, '+user.name+'!')
			res.redirect('/')
		})
	})(req, res, next)
})

r.route('/help')
.get(countNewChallenges())
.get(function(req, res) {
	res.render('help', {
		user: req.user
	})
})

function requireLogin() {
	return function(req, res, next) {
		if(!req.user) {
			return res.redirect('/login')
		}

		next()
	}
}

function requireRole(name) {
	return function(req, res, next) {
		if(req.user.roles.indexOf(name) === -1) {
			return res.redirect('/')
		}

		next()
	}
}

function fetchContest(options) {
	return function(req, res, next) {
		Contest.findById(req.params.id, function(err, contest) {
			if(err) {
				return next(err)
			}
			if(options.required && !contest) {
				return res.send(404)
			}

			req.contest = contest
			next()
		})
	}
}

function fetchParty(options) {
	return function(req, res, next) {
		Party.findById(req.params.id)
		.populate('user')
		.populate('bot')
		.exec(function(err, party) {
			if(err) {
				return next(err)
			}
			if(options.required && !party) {
				return res.send(404)
			}

			req.party = party
			next()
		})
	}
}

function gaugeRate(name, options) {
	return function(req, res, next) {
		var limit = req.user.limits[name]
		if(!limit.epoch || moment().diff(limit.epoch, 'hour') >= 1) {
			limit.epoch = moment().startOf('hour').toDate()
			limit.count = 0
		}
		limit.count += 1
		req.user.save(function(err) {
			if(err) {
				return next(err)
			}

			req.limit = limit
			next()
		})
	}
}

function countNewChallenges() {
	return function(req, res, next) {
		if(!req.user) {
			return next()
		}

		async.series([
			function(next) {
				Challenge.find()
				.where('parties.user').ne(req.user)
				.where({
					$or: [
						{
							'parties.stub.name': req.user.handle.toLowerCase()
						},
						{
							'parties.stub.hash': req.session.t ? new Buffer(req.session.t, 'base64').toString() : '-'
						}
					]
				})
				.where('battle').exists(false)
				.exec(function(err, challenges) {
					if(err) {
						return next(err)
					}

					async.eachSeries(challenges, function(challenge, done) {
						challenge.parties[1].stub = null
						challenge.parties[1].user = req.user
						challenge.save(done)
					}, next)
				})
			},

			function(next) {
				Challenge.count()
				.where('parties.user', req.user)
				.where('battle').exists(false)
				.exec(function(err, count) {
					if(err) {
						return next(err)
					}

					res.locals.newChallengeCount = count
					next()
				})
			}

		], next)
	}
}
