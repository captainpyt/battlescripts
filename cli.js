var mongoose = require('mongoose')

mongoose.connect(process.env.MONGO_URL || process.env.MONGOLAB_URI, function(err) {
	if(err) {
		console.log(err)
		process.exit(1)
	}
})

switch(process.argv[2]) {
	case 'users:add-role':
		var User = require('./lib/user')

		var email = process.argv[3]
		var roleName = process.argv[4]
		User.findByEmail(email, function(err, user) {
			if(err) {
				console.log(err)
				return process.exit(1)
			}

			if(!user) {
				console.log('user not found')
				return process.exit(1)
			}
			if(user.roles.indexOf(roleName) === -1) {
				user.roles.push(roleName)
				user.markModified('roles')
			}
			user.save(function(err) {
				if(err) {
					console.log(err)
					return process.exit(1)
				}

				process.exit(0)
			})
		})
		break

	case 'play':
		var Engine = require('./lib/engine')
		var consts = require('./lib/consts')

		var Player1 = require(process.argv[3])
		var Player2 = require(process.argv[4])

		var engine = new Engine(new Player1(), new Player2())
		engine.play(function(err) {
			if(err) {
				console.log(err)
				return process.exit(1)
			}

			console.log('Done!')

		}, function() {
			console.log('# Step '+engine.records.length)
			console.log()
			for(var y = 0; y < consts.gridSize.height; ++y) {
				var row = []
				for(var playerNo = 0; playerNo < engine.players.length; ++playerNo) {
					for(var j = 0; j < 4; ++j) {
						row.push(' ')
					}
					for(var x = 0; x < consts.gridSize.width; ++x) {
						switch(true) {
							case engine.grids[playerNo][y][x].pieceNo >= 0 && engine.grids[playerNo][y][x].attacked:
								row.push('X')
								break

							case engine.grids[playerNo][y][x].attacked:
								row.push('*')
								break

							case engine.grids[playerNo][y][x].pieceNo >= 0:
								row.push('-')
								break

							default:
								row.push(' ')
								break
						}
					}
				}
				console.log(row.join(''))
			}
			console.log()
			console.log()
		})

		break
}
