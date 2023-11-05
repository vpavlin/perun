# Perun - Privacy-Enabled Running App

<p align="center"><img src="https://github.com/vpavlin/perun/assets/4759808/005804ec-5e2c-4dbb-a2ac-b92d9ceef1f3" /></p>


Introducing Perun, the Privacy-Enabled Running App, where your personal data remains as hidden as the secrets of an ancient, mystical forest. Just as the Slavic god Perun protected the enigmatic Dark Forest, our app safeguards your running data with the utmost care. Your runs, routes, and achievements are yours and yours alone, hidden from prying eyes. With Perun, you can explore the world, keep your privacy intact, and run with the confidence that your data is as secure as the secrets of the universe's cosmic dark forest.

* Deployed at http://perun.vercel.app/
* Video ...
* Pitch ...

## Main features

* Track your run with live map updates and detailed run overview after it is finished
* No data uploads to third party servers
* All data stored locally on your device(s)
* Secure pairing and synchronization over [Waku](https://waku.org)
* Proof-of-Run allowing you to share verified statisticks from your runs

## Future features

* Privacy preserving group runs
* NFT/POAP minting with Proof-of-Run (for single and group runs)
* ZK or iEXEC based proof generation
* Leaderboards

## Proposed Solutions & Encountered Problems

Since we were not able to leverage any ZK technology to generate Proof-of-Run, we wanted to rely on iEXEC DataProtector and iEXEC task. The workflow would be as follows:

### Prerequisity
* A task [Docker image is created](./iexec/), pushed and deployed on iEXEC platform.
* A prover key is uploaded to [SMS](https://protocol.docs.iex.ec/for-developers/confidential-computing/access-confidential-assets).

### Flow
* User uses the app to track a run
* User requests a proof-of-run
* Run log (GPS coordinates + metadata) is uploaded to DataProtector to not reveal any data to third parties
* A task is executed
  * Task fetches the run log from DataProtector
  * Processes the data and generates a proof-of-run object
  * In the post-TEE section of the task, the proof is signed by a prover account (the prover PrivateKey is fetched from SMS)
* User recieves the signed Proof-of-Run without revealing the data to a third party
* User can mint an NFT which has the Proof-of-Run attached

### Problems
* Would were not able to deploy our task due to a need to [sconify](https://protocol.docs.iex.ec/for-developers/confidential-computing/choose-your-tee-framework/create-your-first-sgx-app) the image - which was, based on discussion with iEXEC representatives, not possible during the hackathon
* We could not use DataProtector SDK due to conflicting verions of `ethers.js` package
* Even if the above were resolved, we were not able to find a flow how to execute the task from browser (i.e. upon user request to generate the proof)
* We could not get the NFT minting working due to issues with contract deployment and function execution on CoreDAO

## Run the App

This project was bootstrapped with [Create React App](https://github.com/facebook/create-react-app).

## Available Scripts

In the project directory, you can run:

### `npm start`

Runs the app in the development mode.\
Open [http://localhost:3000](http://localhost:3000) to view it in the browser.

The page will reload if you make edits.\
You will also see any lint errors in the console.

### `npm test`

Launches the test runner in the interactive watch mode.\
See the section about [running tests](https://facebook.github.io/create-react-app/docs/running-tests) for more information.

### `npm run build`

Builds the app for production to the `build` folder.\
It correctly bundles React in production mode and optimizes the build for the best performance.

The build is minified and the filenames include the hashes.\
Your app is ready to be deployed!

See the section about [deployment](https://facebook.github.io/create-react-app/docs/deployment) for more information.

### `npm run eject`

**Note: this is a one-way operation. Once you `eject`, you can’t go back!**

If you aren’t satisfied with the build tool and configuration choices, you can `eject` at any time. This command will remove the single build dependency from your project.

Instead, it will copy all the configuration files and the transitive dependencies (webpack, Babel, ESLint, etc) right into your project so you have full control over them. All of the commands except `eject` will still work, but they will point to the copied scripts so you can tweak them. At this point you’re on your own.

You don’t have to ever use `eject`. The curated feature set is suitable for small and middle deployments, and you shouldn’t feel obligated to use this feature. However we understand that this tool wouldn’t be useful if you couldn’t customize it when you are ready for it.

## Learn More

You can learn more in the [Create React App documentation](https://facebook.github.io/create-react-app/docs/getting-started).

To learn React, check out the [React documentation](https://reactjs.org/).
