import React from "react";
import { useWeb3Modal } from '@web3modal/wagmi/react'
import { useAccount, useConnect, useDisconnect } from 'wagmi'



const Wallet = () => {
    const { open } = useWeb3Modal()
    const { address, isConnecting, isDisconnected } = useAccount()
    const { disconnect } =useDisconnect()



    return (<>
            { !address ?
                 <button className="btn btn-lg btn-primary" onClick={() => open()}>Open Connect Modal</button>
                :
                <button className="btn btn-lg btn-primary" onClick={() => disconnect()}>{address.slice(0,6)}...{address.slice(address.length-4)}</button>
                }
            </>
)

}

export default Wallet;