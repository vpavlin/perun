import React from 'react';
import logo from './logo.svg';
import './App.css';
import { Route, Routes } from 'react-router-dom';
import Main from './pages/main';
import Settings from './pages/settings';
import Run from './components/run/run';
import RunList from './components/runlist/list'


function App() {
  return (
    <div className='bg-base-300 p-4 h-full w-full'>
      <div className="lg:max-w-6xl w-full h-full m-auto bg-base-100 shadow-lg p-4 rounded-xl">
        <Routes>
            <Route path='/' element={<Main />}>
              <Route path="/runs/" element={<RunList />} />
              <Route path='settings/' element={<Settings />} />
              <Route path='run/:id?' element={<Run />} />
            </Route>
          </Routes> 
      </div>
    </div>
  );
}

export default App;
