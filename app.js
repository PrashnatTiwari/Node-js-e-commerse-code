const express = require('express')
const app = express()
app.use(express.json())
const {open} = require('sqlite')
const sqlite3 = require('sqlite3')
const path = require('path')
const dbPath = path.join(__dirname, 'twitterClone.db')
const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')

let db = null

const initializeDBAndServer = async () => {
  try {
    db = await open({
      filename: dbPath,
      driver: sqlite3.Database,
    })
    app.listen(3000, () => {
      console.log('Server is running at http:/localhost:3000/')
    })
  } catch (e) {
    console.log(e.message)
  }
}

initializeDBAndServer()

app.post('/register/', async (request, response) => {
  const {username, password, name, gender} = request.body
  const registerQuery = `SELECT * FROM user WHERE username = '${username}';`
  const dbUser = await db.get(registerQuery)

  if (dbUser === undefined) {
    if (password.length >= 6) {
      const hashedPassword = await bcrypt.hash(password, 10)
      const registerDataQuery = `
      INSERT INTO user (username, password, gender, name)
      VALUES ('${username}', '${hashedPassword}', '${gender}', '${name}')
      `
      await db.run(registerDataQuery)
      response.status(200)
      response.send('User created successfully')
    } else {
      response.status(400)
      response.send('Password is too short')
    }
  } else {
    response.status(400)
    response.send('User already exists')
  }
})

app.post('/login', async (request, response) => {
  const {username, password} = request.body
  const selectUserQuery = `SELECT * FROM user WHERE username = '${username}'`
  const dbUser = await db.get(selectUserQuery)
  if (dbUser === undefined) {
    response.status(400)
    response.send('Invalid user')
  } else {
    const isPasswordMatched = await bcrypt.compare(password, dbUser.password)
    if (isPasswordMatched === true) {
      const payload = {
        username: username,
      }
      const jwtToken = jwt.sign(payload, 'MY_SECRET_TOKEN')
      response.send({jwtToken})
    } else {
      response.status(400)
      response.send('Invalid password')
    }
  }
})

const authenticateToken = (request, response, next) => {
  let jwtToken
  const authHeader = request.headers['authorization']
  if (authHeader !== undefined) {
    jwtToken = authHeader.split(' ')[1]
  }
  if (jwtToken === undefined) {
    response.status(401)
    response.send('Invalid JWT Token')
  } else {
    jwt.verify(jwtToken, 'MY_SECRET_TOKEN', async (error, payload) => {
      if (error) {
        response.status(401)
        response.send('Invalid JWT Token')
      } else {
        request.username = payload.username
        next()
      }
    })
  }
}

const tweetResponse = dbObject => ({
  username: dbObject.username,
  tweet: dbObject.tweet,
  dateTime: dbObject.date_time,
})

app.get('/user/tweets/feed', authenticateToken, async (request, response) => {
  const latestTweetsQuery = `
  SELECT
  tweet.tweet_id,
  tweet.user_id,
  user.username,
  tweet.tweet,
  tweet.date_time
  FROM
  follower
  LEFT JOIN tweet ON tweet.user_id = follower.following_user_id
  LEFT JOIN user on follower.following_user_id = user.user_id
  WHERE follower.follower_user_id = (SELECT user_id FROM user WHERE username = '${request.username}')
  ORDER BY
  tweet.date_time DESC
  LIMIT 4;`
  const latestTweets = await db.all(latestTweetsQuery)
  response.send(latestTweets.map(item => tweetResponse(item)))
})

app.get('/user/following', authenticateToken, async (request, response) => {
  const following = await db.all(`
  SELECT
    user.name
  FROM
    follower
  LEFT JOIN user ON follower.following_user_id = user.user_id
  WHERE follower.follower_user_id = (SELECT user_id FROM user WHERE username = '${request.username}')
  `)
  response.send(following)
})

app.get('/user/followers/', authenticateToken, async (request, response) => {
  const getFollowersQuery = `
   SELECT
    user.name
  FROM
    follower
  LEFT JOIN user ON follower.follower_user_id = user.user_id
  WHERE follower.following_user_id = (SELECT user_id FROM user WHERE username = '${request.username}');`
  const followers = await db.all(getFollowersQuery)
  response.send(followers)
})

const follows = async (request, response, next) => {
  const {tweetId} = request.params
  const getFollowsQuery = `
  SELECT
    *
  FROM
    follower
  WHERE follower_user_id = (SELECT user_id FROM user WHERE username = '${request.username}')
  AND
  following_user_id = (SELECT user.user_id FROM tweet NATURAL JOIN user WHERE tweet_id = ${tweetId});`
  let isFollowing = await db.get(getFollowsQuery)
  if (isFollowing === undefined) {
    response.status(401)
    response.send('Invalid Request')
  } else {
    next()
  }
}

app.get(
  '/tweets/:tweetId/',
  authenticateToken,
  follows,
  async (request, response) => {
    const {tweetId} = request.params
    const {tweet, date_time} = await db.get(`
SELECT tweet, date_time FROM tweet WHERE tweet_id = ${tweetId};`)
    const {likes} = await db.get(`
SELECT count(like_id) as likes from like WHERE tweet_id = ${tweetId};`)
    const {replies} = await db.get(`
SELECT count(reply_id) as replies from reply WHERE tweet_id = ${tweetId};`)
    response.send({tweet, likes, replies, dateTime: date_time})
  },
)

app.get(
  '/tweets/:tweetId/likes/',
  authenticateToken,
  follows,
  async (request, response) => {
    const {tweetId} = request.params
    const likedBy = await db.all(`
SELECT user.username FROM 
like NATURAL JOIN user 
WHERE tweet_id = ${tweetId};`)
    response.send({likes: likedBy.map(item => item.username)})
  },
)

app.get(
  '/tweets/:tweetId/replies/',
  authenticateToken,
  follows,
  async (request, response) => {
    const {tweetId} = request.params
    const replies = await db.all(`
SELECT user.name, reply.reply FROM 
reply NATURAL JOIN user 
WHERE tweet_id = ${tweetId};`)
    response.send({replies})
  },
)

app.get('/user/tweets', authenticateToken, async (request, response) => {
  const myTweets = await db.all(`
SELECT
tweet.tweet,
count(distinct like.like_id) as likes,
count(distinct reply.reply_id) as replies,
tweet.date_time
FROM
tweet
LEFT JOIN LIKE on tweet.tweet_id = like.tweet_id
LEFT JOIN reply on tweet.tweet_id = reply.tweet_id
WHERE tweet.user_id = (SELECT user_id FROM user WHERE username = '${request.username}')
GROUP BY tweet.tweet_id;`)
  response.send(
    myTweets.map(item => {
      const {date_time, ...rest} = item
      return {...rest, dateTime: date_time}
    }),
  )
})

app.post('/user/tweets/', authenticateToken, async (request, response) => {
  const {tweet} = request.body
  const {user_id} = await db.get(
    ` SELECT user_id FROM user WHERE username = '${request.username}'`,
  )
  await db.run(`
  INSERT INTO tweet 
  (tweet, user_id)
  VALUES
  ('${tweet}', '${user_id}')
  `)
  response.send('Created a Tweet')
})

app.delete(
  '/tweets/:tweetId/',
  authenticateToken,
  async (request, response) => {
    const {tweetId} = request.params
    const userTweet = await db.get(`
SELECT
tweet_id, 
user_id
FROM
tweet
WHERE
tweet_id = ${tweetId}
AND user_id = (SELECT user_id FROM user WHERE username = '${request.username}');
  `)
    if (userTweet === undefined) {
      response.status(401)
      response.send('Invalid Request')
    } else {
      await db.run(`
DELETE FROM tweet
WHERE tweet_id = ${tweetId}
    `)
      response.send('Tweet Removed')
    }
  },
)

module.exports = app
